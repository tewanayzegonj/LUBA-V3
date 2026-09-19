/**
 * LUBA V1 — pure ledger posting rules (Phase D financial core).
 *
 * The ledger is the financial truth (TRD §6, Backend Schema §4): append-only
 * journal, one balanced journal entry per economic event, ≥ 2 postings,
 * integer ETB santims, debits == credits per entry and globally.
 *
 * This module is the pure decision core: deterministic, side-effect-free.
 * `src/convex/financial/ledger.ts` wraps it inside the caller's transaction
 * with idempotency + audit. No business amounts are invented here — callers
 * supply every amount.
 *
 * Invariants enforced (FROZEN unless noted):
 *  - balance:            total debits === total credits per entry
 *  - amounts:            positive integer santims only (zero/negative/float rejected)
 *  - postings:           ≥ 2 per entry
 *  - accounts:           fixed chart of accounts; wallet accounts must carry
 *                        a matching `userSide`; platform/provider accounts
 *                        must NOT carry one [IMPL strictness]
 *  - provenance:         refund wallet credits MUST carry the original
 *                        funding lots (FROZEN carrier); tags optional on
 *                        other postings
 *  - append-only:        no update/delete paths exist for the journal —
 *                        corrections are new entries [IMPL]
 *  - vocabulary:         kinds, ref types, directions are closed contracts
 */
import type { Id } from "../_generated/dataModel";
import {
  LEDGER_ENTRY_KINDS,
  LEDGER_REF_TYPES,
  POSTING_DIRECTIONS,
  walletAccount,
  type LedgerEntryKind,
  type LedgerRefType,
  type PostingDirection,
} from "./contracts";
import { sumSantim, validateSantim } from "./money";

/** One posting line of a journal-entry draft. */
export type PostingDraft = {
  /** Chart-of-accounts string (§4.3, fixed). */
  account: string;
  /** REQUIRED (and must match the account) when `account` is a wallet account. */
  userSide?: Id<"users"> | null;
  direction: PostingDirection;
  /** > 0, integer santims. */
  amountSantim: number;
  /** Funding-provenance tag. REQUIRED on refund wallet credits (FROZEN). */
  provenanceLotIds?: Id<"provenanceLots">[];
};

/** A complete journal-entry draft as composed by an economic operation. */
export type LedgerEntryDraft = {
  kind: LedgerEntryKind;
  refType: LedgerRefType;
  /** Typed `Id<…>` at the mutation layer; carried as string (index-safe). */
  refId: string;
  /** ≥ 2 postings; total debits must equal total credits. */
  postings: PostingDraft[];
};

export type LedgerRejection =
  | "invalid_kind"
  | "invalid_ref_type"
  | "invalid_ref_id"
  | "invalid_postings"
  | "invalid_posting"
  | "invalid_account"
  | "user_side_required"
  | "user_side_mismatch"
  | "user_side_forbidden"
  | "unbalanced_entry"
  | "provenance_required";

export type LedgerEvaluation =
  | { ok: true }
  | { ok: false; reason: LedgerRejection };

function isMember<T extends readonly string[]>(value: string, set: T): value is T[number] {
  return (set as readonly string[]).includes(value);
}

/** True iff the account string is a user wallet account (`wallet:{userId}`). */
export function isWalletAccount(account: string): boolean {
  return account.startsWith("wallet:");
}

/** Validate one posting line. Deterministic; no I/O. */
export function evaluatePosting(
  posting: PostingDraft,
): { ok: true } | { ok: false; reason: LedgerRejection } {
  if (typeof posting.account !== "string" || posting.account.length === 0) {
    return { ok: false, reason: "invalid_account" };
  }
  if (!isMember(posting.direction, POSTING_DIRECTIONS)) {
    return { ok: false, reason: "invalid_posting" };
  }
  const amount = validateSantim(posting.amountSantim); // > 0 integer — zero/negative/float rejected
  if (!amount.ok) return { ok: false, reason: "invalid_posting" };

  const wallet = isWalletAccount(posting.account);
  if (wallet) {
    if (posting.userSide == null || posting.userSide.length === 0) {
      return { ok: false, reason: "user_side_required" };
    }
    // The wallet account must be exactly this user's wallet account.
    if (posting.account !== walletAccount(posting.userSide)) {
      return { ok: false, reason: "user_side_mismatch" };
    }
  } else if (posting.userSide != null) {
    // Platform/provider accounts never carry a user side.
    return { ok: false, reason: "user_side_forbidden" };
  }

  if (posting.provenanceLotIds !== undefined) {
    if (!Array.isArray(posting.provenanceLotIds) || posting.provenanceLotIds.length === 0) {
      return { ok: false, reason: "invalid_posting" };
    }
  }
  return { ok: true };
}

/**
 * Net wallet delta per user from a draft's wallet postings, expressed from
 * the USER's perspective (credit-positive: a credit to their wallet account
 * increases their available balance, a debit decreases it). Deterministic;
 * multiple postings for the same user sum into one delta. Zero-delta users
 * are omitted. The wallet-projection primitive applies this net delta to the
 * projected available balance in the SAME transaction as the journal entry.
 */
export function netWalletDeltas(
  postings: readonly PostingDraft[],
): Map<Id<"users">, number> {
  const deltas = new Map<Id<"users">, number>();
  for (const posting of postings) {
    if (!isWalletAccount(posting.account) || posting.userSide == null) continue;
    const signed = posting.direction === "credit" ? posting.amountSantim : -posting.amountSantim;
    deltas.set(posting.userSide, (deltas.get(posting.userSide) ?? 0) + signed);
  }
  for (const [user, delta] of deltas) {
    if (delta === 0) deltas.delete(user);
  }
  return deltas;
}

/**
 * Validate a complete journal-entry draft: vocabulary membership, ≥ 2
 * postings, per-posting rules, the balance invariant, and the FROZEN
 * provenance rule (refund wallet credits must be tagged with their funding
 * lots). Callers compose the amounts — nothing here invents values.
 */
export function evaluateLedgerEntry(entry: LedgerEntryDraft): LedgerEvaluation {
  if (!isMember(entry.kind, LEDGER_ENTRY_KINDS)) return { ok: false, reason: "invalid_kind" };
  if (!isMember(entry.refType, LEDGER_REF_TYPES)) return { ok: false, reason: "invalid_ref_type" };
  if (typeof entry.refId !== "string" || entry.refId.length === 0) {
    return { ok: false, reason: "invalid_ref_id" };
  }
  if (!Array.isArray(entry.postings) || entry.postings.length < 2) {
    return { ok: false, reason: "invalid_postings" };
  }

  for (const posting of entry.postings) {
    const evaluated = evaluatePosting(posting);
    if (!evaluated.ok) return evaluated;
  }

  const debits = sumSantim(
    entry.postings.filter((p) => p.direction === "debit").map((p) => p.amountSantim),
  );
  if (!debits.ok) return { ok: false, reason: "invalid_posting" };
  const credits = sumSantim(
    entry.postings.filter((p) => p.direction === "credit").map((p) => p.amountSantim),
  );
  if (!credits.ok) return { ok: false, reason: "invalid_posting" };

  // Balance invariant (FROZEN): debits === credits, exactly, in santims.
  if (debits.value !== credits.value) return { ok: false, reason: "unbalanced_entry" };

  // Provenance (FROZEN): every refund that credits a wallet carries the lots
  // that originally funded the refunded amount — traceable, never reclassified.
  for (const posting of entry.postings) {
    if (
      entry.kind === "refund" &&
      posting.direction === "credit" &&
      isWalletAccount(posting.account) &&
      (posting.provenanceLotIds === undefined || posting.provenanceLotIds.length === 0)
    ) {
      return { ok: false, reason: "provenance_required" };
    }
  }

  return { ok: true };
}
