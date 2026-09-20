/**
 * LUBA V1 — server-side bid submission primitive (Phase H).
 *
 * THE one transactional path for every bid (Backend Schema §9 / TRD §8),
 * composed inside the CALLER's single Convex transaction:
 *
 *   authorize (caller: requireVerifiedPhoneUser — fail-closed)
 *   → idempotency check (Phase B foundation; user-bound key)
 *   → load auction + verify OPEN + server time (pure core)
 *   → validate amount / apply configured policy (pure core; unset fee ⇒
 *     fail safely — no invented default)
 *   → insert the bid row (ACCEPTED with the configured fee)
 *   → charge the fee atomically (validates balance BEFORE any write):
 *       debit  wallet:{userId}          feeSantim   (funds out)
 *       credit platform:bid_fee_revenue feeSantim   (platform revenue)
 *     balanced `bid_fee` journal entry referencing the bid id; wallet
 *     projection updated in the SAME transaction. Insufficient balance ⇒
 *     the bid row is patched to REJECTED/insufficient_funds (frozen
 *     audit-row semantics, zero economic effect) — never an orphan
 *     ACCEPTED bid, never a partial charge.
 *   → provenance lots consumed for the debit (allocation ORDER stays
 *     OPEN — the caller here orders newest-first, presentation-neutral,
 *     NOT a frozen policy; divergence is an invariant abort)
 *   → anti-snipe via the Phase G seam — ONLY after the accepted bid + fee
 *     exist (deterministic, bounded, unset ⇒ inactive, zero effect)
 *   → audit `bid.accepted` / `bid.rejected` (frozen vocabulary)
 *   → idempotency commit — replay returns the original result verbatim
 *
 * Guarantees:
 *  - no partial success: a bid never exists without its fee, a fee never
 *    moves without its accepted bid; any throw aborts the whole transaction
 *    (Convex OCC removes partial writes — no compensating cleanup);
 *  - server-authoritative time only (`now` from the mutation boundary);
 *  - blind bidding is structural: nothing here computes or exposes
 *    uniqueness, ranking, distribution, or winners;
 *  - exactly-once economics per idempotency key (cross-user replay is
 *    structurally impossible — the key binds the user).
 *
 * Account restrictions & future rate/abuse controls (enforcement seam):
 *  - CURRENT: the only account restriction enforced is the frozen
 *    verified-phone requirement (caller, fail-closed). No bid-volume cap,
 *    duplicate-amount rule, or account-tier restriction exists in the
 *    contract, so none is evaluated here — no policy values are invented.
 *  - FUTURE SEAM (Phase B/C contracts already in place): an account-
 *    eligibility evaluation belongs as a pure decision core in
 *    `domain/bids.ts`, invoked inside `submitBid` after the configured
 *    policy validation and BEFORE wallet validation — a refusal there
 *    persists the frozen REJECTED row (zero economic effect) exactly like
 *    the other bid-path classes. A rate/abuse check (e.g. against
 *    `rateAbuseEvents`) belongs at the `placeBid` mutation boundary in
 *    `bids.ts`, BEFORE the transaction — it must refuse without economic
 *    effect and without fabricating thresholds. Nothing is pre-wired:
 *    activation awaits the still-OPEN PRD decisions (bid-volume cap,
 *    anti-abuse rules).
 *
 * Not implemented here (Phase I+): winner determination, settlement,
 * refunds, no-winner processing.
 */
import type { Id } from "../_generated/dataModel";
import type { RejectionReason } from "../domain/contracts";
import {
  evaluateBidSubmission,
  isPersistableRejection,
  projectOwnBid,
  type OwnBid,
} from "../domain/bids";
import { recordAuditEvent, type AuditCtx } from "../guards/audit";
import {
  checkIdempotencyKey,
  commitIdempotencyKey,
  deriveIdempotencyKey,
  fingerprintRequest,
} from "../guards/idempotency";
import { consumeProvenanceLots } from "./provenance";
import { postWalletTransaction, type WalletCtx } from "./wallet";
import { applyAntiSnipeExtension } from "../auction/lifecycle";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type BidDbRow = Record<string, unknown> & { _id: string };

/** The auction fields the bid path reads (structurally — no row coupling). */
type BidAuctionRow = {
  _id: string;
  code?: string;
  status: string;
  startAt?: number;
  closeAt: number;
  minBidSantim?: number;
  maxBidSantim?: number;
  feeSantim?: number;
};

export type BidDb = {
  get: (id: string) => Promise<BidDbRow | null>;
  insert: (table: "bids", doc: Record<string, unknown>) => Promise<string>;
  patch: (id: string, doc: Record<string, unknown>) => Promise<void>;
  query: (table: "provenanceLots") => {
    withIndex: (
      name: string,
      fn: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
    ) => {
      collect: () => Promise<BidDbRow[]>;
    };
  };
};

export type BidTx = { db: unknown };

/* ── Input / output ── */

export type SubmitBidInput = {
  auctionId: Id<"auctions">;
  /** Resolved server-side by the caller (requireVerifiedPhoneUser). */
  bidderId: Id<"users">;
  /** Client's idempotency token for this logical bid attempt. */
  idempotencyToken: string;
  amountSantim: number;
  /** Server clock (TRD §17) from the mutation boundary. */
  now: number;
};

export type SubmitBidResult =
  | {
      ok: true;
      status: "accepted";
      bidId: Id<"bids">;
      /** The bid's balanced `bid_fee` journal entry (financial truth). */
      ledgerEntryId: Id<"ledgerEntries">;
      /** Wallet projection balance AFTER the fee debit. */
      walletBalanceSantim: number;
      /** Set when this accepted bid moved the authoritative close time. */
      antiSnipeNewCloseAt: number | null;
    }
  | {
      ok: true;
      status: "replay";
      /** Original result fields, returned verbatim — zero new effect. */
      bidId: Id<"bids"> | null;
      antiSnipeNewCloseAt: number | null;
    }
  | {
      ok: false;
      status: "rejected";
      /** Frozen closed-vocab reason — persisted as a REJECTED row. */
      reason: RejectionReason;
      bidId: Id<"bids">;
    }
  | {
      ok: false;
      status: "refused";
      /** Non-bid-path failure class (session/config/idempotency): returned
       * without a bid row and without economic effect. */
      reason:
        | "auction_not_found"
        | "invalid_amount"
        | "invalid_bounds"
        | "bid_fee_unconfigured"
        | "invalid_fee_config"
        | "idempotency_conflict";
    };

/* ── REJECTED-row persistence (frozen audit/status semantics) ── */

async function persistRejection(
  ctx: BidTx,
  args: {
    bidId: Id<"bids">;
    key: string;
    fingerprint: string;
    auctionId: Id<"auctions">;
    bidderId: Id<"users">;
    amountSantim: number;
    now: number;
    reason: RejectionReason;
    isNewRow: boolean;
  },
): Promise<void> {
  const db = ctx.db as BidDb;
  if (args.isNewRow) {
    await db.patch(args.bidId, {
      status: "REJECTED",
      rejectionReason: args.reason,
      feeSantim: 0,
      refundStatus: "not_refundable",
    });
  }
  await recordAuditEvent(ctx as unknown as AuditCtx, {
    actorId: args.bidderId,
    actorRole: "user",
    action: "bid.rejected",
    entityType: "bids",
    entityId: args.bidId,
    idempotencyKey: args.key,
    amountSantim: undefined,
    meta: { auctionId: args.auctionId, reason: args.reason },
  });
  await commitIdempotencyKey(ctx, {
    key: args.key,
    op: "bid",
    userId: args.bidderId,
    fingerprint: args.fingerprint,
    refType: "bids",
    refId: args.bidId,
    outcome: JSON.stringify({ bidId: args.bidId, rejected: args.reason }),
  });
}

/* ── The one transactional path ── */

export async function submitBid(
  ctx: BidTx,
  input: SubmitBidInput,
): Promise<SubmitBidResult> {
  const db = ctx.db as BidDb;

  // ── Idempotency check (before any decision or write) ──
  const key = deriveIdempotencyKey({
    op: "bid",
    userId: input.bidderId,
    clientToken: input.idempotencyToken,
  });
  // Fingerprint covers the semantic request: auction + amount. Time is
  // server-derived, so it is deliberately excluded — a retry of the same
  // logical bid at a different wall-clock second is the SAME request.
  const fingerprint = fingerprintRequest({
    auctionId: input.auctionId,
    amountSantim: input.amountSantim,
  });
  const registry = await checkIdempotencyKey(ctx, { key, fingerprint });
  if (registry.status === "conflict") {
    return { ok: false, status: "refused", reason: "idempotency_conflict" };
  }
  if (registry.status === "replay") {
    try {
      const outcome = JSON.parse(registry.outcome) as {
        bidId?: string;
        antiSnipeNewCloseAt?: number | null;
        rejected?: RejectionReason;
      };
      if (outcome.rejected !== undefined) {
        // The original attempt was a frozen-path REJECTION: reproduce it
        // faithfully — same status/reason shape, zero new effect.
        return {
          ok: false,
          status: "rejected",
          reason: outcome.rejected,
          bidId: (outcome.bidId ?? "") as Id<"bids">,
        };
      }
      return {
        ok: true,
        status: "replay",
        bidId: (outcome.bidId ?? null) as Id<"bids"> | null,
        antiSnipeNewCloseAt: typeof outcome.antiSnipeNewCloseAt === "number" ? outcome.antiSnipeNewCloseAt : null,
      };
    } catch {
      // Outcome envelope unreadable — surface a null-bidId replay rather
      // than fabricating a result; the key still blocks re-execution.
      return { ok: true, status: "replay", bidId: null, antiSnipeNewCloseAt: null };
    }
  }

  // ── Load auction + verify OPEN + server time + policy (pure core) ──
  const auction = (await db.get(input.auctionId)) as BidAuctionRow | null;
  if (auction === null) {
    return { ok: false, status: "refused", reason: "auction_not_found" };
  }
  const decision = evaluateBidSubmission({
    auctionStatus: auction.status as never,
    startAt: auction.startAt,
    closeAt: auction.closeAt,
    now: input.now,
    amountSantim: input.amountSantim,
    minBidSantim: auction.minBidSantim ?? null,
    maxBidSantim: auction.maxBidSantim ?? null,
    feeSantim: auction.feeSantim ?? null,
  });
  if (!decision.ok) {
    if (isPersistableRejection(decision.reason)) {
      // Frozen bid-path class: persist the REJECTED audit row + idempotent
      // replay outcome. Zero economic effect (schema: REJECTED rows are
      // audit/status only).
      const bidId = (await db.insert("bids", {
        auctionId: input.auctionId,
        bidderId: input.bidderId,
        amountSantim: input.amountSantim,
        feeSantim: 0,
        status: "REJECTED",
        rejectionReason: decision.reason,
        refundStatus: "not_refundable",
        placedAt: input.now,
        idempotencyKey: key,
      })) as Id<"bids">;
      await persistRejection(ctx, {
        bidId,
        key,
        fingerprint,
        auctionId: input.auctionId,
        bidderId: input.bidderId,
        amountSantim: input.amountSantim,
        now: input.now,
        reason: decision.reason,
        isNewRow: false,
      });
      return { ok: false, status: "rejected", reason: decision.reason, bidId };
    }
    // Configuration class (unset bounds policy / unset fee / invalid fee):
    // fail safely — no bid row, no default, no economic effect.
    return { ok: false, status: "refused", reason: decision.reason as never };
  }
  const feeSantim = decision.feeSantim;

  // ── Insert the accepted bid row FIRST — the fee then references the real
  //    bid id. If the fee charge refuses cleanly below, this row is patched
  //    to REJECTED in the same transaction (never an orphan ACCEPTED bid). ──
  const bidId = (await db.insert("bids", {
    auctionId: input.auctionId,
    bidderId: input.bidderId,
    amountSantim: input.amountSantim,
    feeSantim,
    status: "ACCEPTED",
    refundStatus: "not_refundable",
    placedAt: input.now,
    idempotencyKey: key,
  })) as Id<"bids">;

  // ── Charge the fee + validate balance atomically. Preconditions run
  //    inside postWalletTransaction BEFORE any write: insufficient balance
  //    is a clean rejection — the bid row is patched to REJECTED and the
  //    result is idempotently recorded. ──
  const posted = await postWalletTransaction(ctx as unknown as WalletCtx, {
    kind: "bid_fee",
    refType: "bid",
    refId: bidId,
    walletLegs: [{ userId: input.bidderId, deltaSantim: -feeSantim }],
    counterpartPostings: [
      {
        account: "platform:bid_fee_revenue",
        direction: "credit",
        amountSantim: feeSantim,
      },
    ],
    ownerUserId: input.bidderId,
    idempotencyToken: `fee:${input.idempotencyToken}`,
    idempotencyOp: "bid",
  });
  if (!posted.ok) {
    const reason = posted.status === "conflict" ? "idempotency_conflict" : posted.reason;
    if (reason === "insufficient_funds") {
      await persistRejection(ctx, {
        bidId,
        key,
        fingerprint,
        auctionId: input.auctionId,
        bidderId: input.bidderId,
        amountSantim: input.amountSantim,
        now: input.now,
        reason: "insufficient_funds",
        isNewRow: true, // patch the ACCEPTED row in place → REJECTED
      });
      return { ok: false, status: "rejected", reason: "insufficient_funds", bidId };
    }
    // Any other refusal is an invariant violation — abort (zero effect).
    throw new Error(`bid fee charge refused: ${reason}`);
  }
  if (posted.status !== "posted") {
    // A fee-ledger replay inside a fresh bid attempt is an invariant
    // violation (the effect must run exactly once) — abort the transaction.
    throw new Error("bid fee ledger replay is unreachable");
  }

  // ── Provenance: consume the funding lots behind the fee debit. The
  //    allocation ORDER stays OPEN (FIFO is only a candidate); this caller
  //    orders newest-first, which the Phase D primitive accepts as-is. ──
  const openLots = (await db
    .query("provenanceLots")
    .withIndex("by_user", (q) => q.eq("userId", input.bidderId))
    .collect()) as BidDbRow[];
  const orderedLotIds = openLots
    .filter((lot) => lot.status === "open" && (lot.remainingSantim as number) > 0)
    .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
    .map((lot) => lot._id) as Id<"provenanceLots">[];
  const consumed = await consumeProvenanceLots(ctx, {
    ownerUserId: input.bidderId,
    requestedSantim: feeSantim,
    orderedLotIds,
  });
  if (!consumed.ok) {
    // Provenance and balance are kept in lockstep by construction; any
    // divergence is an invariant failure — abort (zero partial effect).
    throw new Error(`provenance consumption failed: ${consumed.reason}`);
  }

  // ── Anti-snipe — ONLY after the accepted bid + fee exist in this
  //    transaction (Phase G seam: deterministic, bounded, unset ⇒ inactive
  //    with zero effect). Any throw aborts everything above too. ──
  let antiSnipeNewCloseAt: number | null = null;
  const antiSnipe = await applyAntiSnipeExtension(
    ctx as unknown as Parameters<typeof applyAntiSnipeExtension>[0],
    { auctionId: input.auctionId, now: input.now },
  );
  if (antiSnipe.ok && antiSnipe.active) antiSnipeNewCloseAt = antiSnipe.newCloseAt;

  // ── Audit + idempotency commit — same transaction as every write above ──
  await recordAuditEvent(ctx as unknown as AuditCtx, {
    actorId: input.bidderId,
    actorRole: "user",
    action: "bid.accepted",
    entityType: "bids",
    entityId: bidId,
    idempotencyKey: key,
    amountSantim: input.amountSantim,
    meta: {
      auctionId: input.auctionId,
      feeSantim,
      ledgerEntryId: posted.entryId,
      antiSnipeNewCloseAt,
    },
  });
  const balanceSantim = posted.balances.find((b) => b.userId === input.bidderId)
    ?.availableSantim;
  await commitIdempotencyKey(ctx, {
    key,
    op: "bid",
    userId: input.bidderId,
    fingerprint,
    refType: "bids",
    refId: bidId,
    outcome: JSON.stringify({
      bidId,
      ledgerEntryId: posted.entryId,
      antiSnipeNewCloseAt,
    }),
  });

  return {
    ok: true,
    status: "accepted",
    bidId,
    ledgerEntryId: posted.entryId,
    walletBalanceSantim: balanceSantim as number,
    antiSnipeNewCloseAt,
  };
}

/* ── User-owned bid projection (query-side helper, blind-safe) ── */

/**
 * Project the caller's OWN bids for one auction (PRD Q22 frozen shape:
 * amount, fee, transactional status, refund status — never uniqueness or
 * ranking; the whitelist IS the boundary).
 */
export function projectOwnBids(rows: Array<Record<string, unknown>>): OwnBid[] {
  return rows.map((row) => projectOwnBid(row as Parameters<typeof projectOwnBid>[0]));
}
