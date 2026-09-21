/**
 * LUBA V1 — wallet projection foundation (server-side, Phase D).
 *
 * The wallet is a PROJECTION (TRD §6, Backend Schema §3): the ledger stays
 * the financial truth. This module maintains the projection — 1:1 with
 * users, integer ETB santims, non-negative — and provides the reusable
 * atomic primitive future economic operations will call:
 *
 *   postWalletTransaction(ctx, input) = postLedgerTransaction + projection
 *   update, in the SAME Convex transaction, all-or-nothing.
 *
 * No deposit/bid/refund/withdrawal/settlement flow lives here: economic
 * operations compose this primitive and supply every amount. Wallet
 * balances are never patched outside this module; no OPEN business value
 * (fees, bounds, limits) is invented or defaulted.
 */
import type { Doc, Id } from "../_generated/dataModel";

import type { IdempotencyOp, LedgerEntryKind, LedgerRefType } from "../domain/contracts";
import { netWalletDeltas, type PostingDraft } from "../domain/ledger";
import { validateWalletProjection } from "../domain/rules";
import {
  postLedgerTransaction,
  type LedgerCtx,
} from "./ledger";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

type WalletRow = {
  _id: string;
  userId: string;
  availableSantim: number;
  updatedAt: number;
};

type WalletDb = {
  insert: (
    table: "wallets",
    doc: { userId: string; availableSantim: number; updatedAt: number },
  ) => Promise<string>;
  get: (id: string) => Promise<WalletRow | null>;
  patch: (id: string, doc: { availableSantim: number; updatedAt: number }) => Promise<void>;
  query: (table: "wallets") => {
    withIndex: (
      name: "by_user",
      fn: (q: { eq: (field: "userId", value: string) => unknown }) => unknown,
    ) => {
      unique: () => Promise<WalletRow | null>;
      collect: () => Promise<WalletRow[]>;
    };
  };
};

export type WalletCtx = LedgerCtx;

/* ── ensureWallet — 1:1 provisioning boundary ── */

export type EnsureWalletResult =
  | { ok: true; walletId: string; created: boolean; availableSantim: number }
  | { ok: false; reason: "duplicate_wallets" | "invalid_wallet" };

/**
 * Provision the 1:1 wallet projection for a user (Backend Schema §3) or
 * return the existing one. Uniqueness is enforced via the `by_user` lookup
 * guard (Convex has no native unique indexes); racing provisioners abort
 * via Convex OCC and retry. The projection always starts at 0 santim —
 * balances change ONLY through balanced journal entries.
 */
export async function ensureWallet(
  ctx: WalletCtx,
  userId: Id<"users">,
): Promise<EnsureWalletResult> {
  const db = ctx.db as WalletDb;
  // Collect-based 1:1 guard: 0 rows → create; 1 row → reuse; > 1 rows is an
  // invariant violation (one wallet per user, Backend Schema §3) reported as
  // `duplicate_wallets` instead of silently reusing an arbitrary row.
  const existingRows = await db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  if (existingRows.length > 1) return { ok: false, reason: "duplicate_wallets" };
  const existing = existingRows[0];
  if (existing !== undefined) {
    const valid = validateWalletProjection(existing.availableSantim);
    if (!valid.ok) return { ok: false, reason: "invalid_wallet" };
    return { ok: true, walletId: existing._id, created: false, availableSantim: valid.value };
  }

  const walletId = await db.insert("wallets", {
    userId,
    availableSantim: 0,
    updatedAt: Date.now(),
  });
  return { ok: true, walletId, created: true, availableSantim: 0 };
}

/* ── postWalletTransaction — the atomic economic primitive ── */

export type WalletTxLeg = {
  userId: Id<"users">;
  /** > 0 integer santims. Sign fixes direction: `+` credit (funds in),
   * `-` debit (funds out). The leg is a single signed delta per user. */
  deltaSantim: number;
  /**
   * Funding-provenance tag (Phase I): lot ids carried onto THIS leg's wallet
   * ledger posting (`ledgerPostings.provenanceLotIds` — the FROZEN provenance
   * carrier, Backend Schema §4.2: "set on wallet credits created by refunds
   * and tracked on debits for lot consumption"). Bid fees attach the lots
   * the debit consumed; refunds attach the lots being re-credited. */
  provenanceLotIds?: Id<"provenanceLots">[];
};

export type PostWalletTransactionInput = {
  kind: LedgerEntryKind;
  refType: LedgerRefType;
  refId: string;
  /** ≥ 1 signed wallet legs; zero deltas are rejected (no phantom effects). */
  walletLegs: WalletTxLeg[];
  /** Non-wallet counterpart postings completing the double entry. */
  counterpartPostings: PostingDraft[];
  ownerUserId: Id<"users"> | null;
  idempotencyToken: string;
  idempotencyOp: IdempotencyOp;
};

export type PostWalletTransactionResult =
  | {
      ok: true;
      status: "posted";
      entryId: Id<"ledgerEntries">;
      outcome: string;
      /** Projection balance AFTER the effect, per touched user. */
      balances: Array<{ userId: Id<"users">; availableSantim: number }>;
    }
  | {
      ok: true;
      status: "replay";
      outcome: string;
      entryId: Id<"ledgerEntries"> | null;
      /** On replay, no projection mutation occurred; balances are null. */
      balances: null;
    }
  | { ok: false; status: "conflict"; reason: "idempotency_conflict" }
  | {
      ok: false;
      status: "rejected";
      reason: string;
    };

/**
 * Post a balanced journal entry AND update the affected wallet projections
 * in the SAME transaction. All-or-nothing:
 *
 *  1. Precondition checks (availability, non-zero deltas) run BEFORE any
 *     write — a rejected call leaves zero economic effect.
 *  2. The ledger primitive refuses unbalanced/invalid drafts before writes.
 *  3. Projection updates happen after the entry is appended; any failure or
 *     OCC abort in the surrounding transaction removes ALL of it — a wallet
 *     can never move without its balanced journal entry, and vice versa.
 *  4. Replay of the same key returns the original outcome with zero writes.
 *
 * Insufficient available balance is a clean `insufficient_funds` rejection
 * (FROZEN balance guard): no holds, no partial debit, no negative balance.
 */
export async function postWalletTransaction(
  ctx: WalletCtx,
  input: PostWalletTransactionInput,
): Promise<PostWalletTransactionResult> {
  const db = ctx.db as WalletDb;

  // ── Precondition phase (no writes yet) ──

  if (!Array.isArray(input.walletLegs) || input.walletLegs.length === 0) {
    return { ok: false, status: "rejected", reason: "no_wallet_legs" };
  }
  for (const leg of input.walletLegs) {
    if (
      typeof leg.deltaSantim !== "number" ||
      !Number.isInteger(leg.deltaSantim) ||
      leg.deltaSantim === 0
    ) {
      return { ok: false, status: "rejected", reason: "invalid_wallet_leg" };
    }
  }

  // Wallet postings from the signed legs; the shared pure helper aggregates
  // the net credit-positive delta per user (multiple legs for one user
  // collapse into a single net movement — no phantom intermediate effects).
  const walletPostings: PostingDraft[] = input.walletLegs.map((leg) => ({
    account: `wallet:${leg.userId}`,
    userSide: leg.userId,
    direction: leg.deltaSantim > 0 ? ("credit" as const) : ("debit" as const),
    amountSantim: Math.abs(leg.deltaSantim),
    // Phase I seam: the leg's provenance tag lands on its posting verbatim
    // (debits track consumption; refund credits tag the restored lots).
    ...(leg.provenanceLotIds !== undefined ? { provenanceLotIds: leg.provenanceLotIds } : {}),
  }));
  const netDeltas = netWalletDeltas(walletPostings);
  if (netDeltas.size === 0) {
    return { ok: false, status: "rejected", reason: "no_wallet_legs" };
  }

  // Fetch projections and validate the resulting balances BEFORE writing.
  const projections = new Map<Id<"users">, WalletRow>();
  for (const [userId] of netDeltas) {
    const wallet = await db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (wallet === null) {
      return { ok: false, status: "rejected", reason: "wallet_not_found" };
    }
    const valid = validateWalletProjection(wallet.availableSantim);
    if (!valid.ok) return { ok: false, status: "rejected", reason: "invalid_wallet" };
    projections.set(userId, wallet);
  }

  const resultingBalances = new Map<Id<"users">, number>();
  for (const [userId, delta] of netDeltas) {
    const wallet = projections.get(userId);
    if (wallet === undefined) return { ok: false, status: "rejected", reason: "wallet_not_found" };
    const resulting = wallet.availableSantim + delta;
    if (resulting < 0) {
      // FROZEN balance guard: insufficient funds ⇒ zero economic effect.
      return { ok: false, status: "rejected", reason: "insufficient_funds" };
    }
    resultingBalances.set(userId, resulting);
  }

  // ── Ledger postings (via the finalized primitive) ──

  const postings: PostingDraft[] = [...walletPostings, ...input.counterpartPostings];

  const posted = await postLedgerTransaction(ctx, {
    kind: input.kind,
    refType: input.refType,
    refId: input.refId,
    postings,
    ownerUserId: input.ownerUserId,
    idempotencyToken: input.idempotencyToken,
    idempotencyOp: input.idempotencyOp,
  });

  // ── Replay / conflict: zero projection mutation ──
  if (!posted.ok) {
    return posted.status === "conflict"
      ? { ok: false, status: "conflict", reason: posted.reason }
      : { ok: false, status: "rejected", reason: posted.reason };
  }
  if (posted.status === "replay") {
    return {
      ok: true,
      status: "replay",
      outcome: posted.outcome,
      entryId: posted.entryId,
      balances: null,
    };
  }

  // ── Projection update — same transaction as the journal entry ──
  const balances: Array<{ userId: Id<"users">; availableSantim: number }> = [];
  for (const [userId, resulting] of resultingBalances) {
    const wallet = projections.get(userId);
    if (wallet === undefined) {
      // Unreachable in practice (checked above) — abort rather than guess.
      throw new Error("wallet projection disappeared mid-transaction");
    }
    await db.patch(wallet._id, { availableSantim: resulting, updatedAt: Date.now() });
    balances.push({ userId, availableSantim: resulting });
  }

  return {
    ok: true,
    status: "posted",
    entryId: posted.entryId,
    outcome: posted.outcome,
    balances,
  };
}

/* ── Read-only wallet audit checks (reconciliation support) ── */

export type WalletIntegrityFinding =
  | { type: "invalid_balance"; walletId: string; availableSantim: number }
  | { type: "negative_balance"; walletId: string; availableSantim: number };

/**
 * Read-only structural check of wallet projection rows: balances must be
 * non-negative integer santims. Ledger-vs-projection comparison lives in
 * `domain/reconciliation.ts`; this only flags structurally invalid rows.
 */
export function auditWalletRows(
  wallets: readonly WalletProjectionRow[],
): WalletIntegrityFinding[] {
  const findings: WalletIntegrityFinding[] = [];
  for (const wallet of wallets) {
    if (wallet.availableSantim < 0) {
      findings.push({ type: "negative_balance", walletId: wallet._id, availableSantim: wallet.availableSantim });
    } else if (!Number.isInteger(wallet.availableSantim)) {
      findings.push({ type: "invalid_balance", walletId: wallet._id, availableSantim: wallet.availableSantim });
    }
  }
  return findings;
}

export type WalletProjectionRow = Pick<Doc<"wallets">, "_id" | "userId" | "availableSantim">;
