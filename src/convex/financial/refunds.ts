/**
 * LUBA V1 — shared per-bid refund engine (Phase I, frozen plan §9).
 *
 * The one server-side per-bid refund operation, shared by NO_WINNER-at-close
 * and deadline-void campaigns. Invoked chunk-wise by the settlement worker.
 *
 * Per-bid atomicity is MANDATORY (frozen TRD §11); batch-level atomicity is
 * deliberately NOT recreated. Within one chunk transaction, each bid is
 * fully refunded or not at all:
 *
 *   guard (ACCEPTED + not_refundable + positive fee; already-refunded ⇒
 *          clean no-op replay, zero effect)
 *   → restore the EXACT provenance the fee consumed (from the fee's
 *     idempotency outcome envelope — lot → amount records; never
 *     reclassified, never exceeding original lots)
 *   → credit the bidder's wallet by the exact fee (journal kind "refund",
 *     distinct class; wallet posting tagged with the restored lot ids per
 *     Backend Schema §4.2; projection updated in the same transaction)
 *   → insert bidRefunds (by_bid unique — structural exactly-once)
 *   → mark bid refundStatus = refunded
 *   → audit refund.credited (system-attributed)
 *   → system-owned per-bid idempotency (`refund` op, key = bid id)
 *
 * No duplicate economic effect on retry/replay/OCC restart.
 * No external auto-refund (frozen); refunds land in the LUBA wallet only.
 */
import type { Id } from "../_generated/dataModel";

import { decodeOutcome } from "../guards/idempotency";
import {
  checkIdempotencyKey,
  commitIdempotencyKey,
  deriveIdempotencyKey,
  fingerprintRequest,
  type IdempotencyCtx,
} from "../guards/idempotency";
import { recordAuditEvent, type AuditCtx } from "../guards/audit";
import { restoreProvenanceLots } from "./provenance";
import { postWalletTransaction, type WalletCtx } from "./wallet";
import { evaluateRefundEligibility } from "../domain/settlement";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type RefundDbRow = Record<string, unknown> & { _id: string };

type RefundDb = {
  get: (id: string) => Promise<RefundDbRow | null>;
  insert: (table: "bidRefunds", doc: Record<string, unknown>) => Promise<string>;
  patch: (id: string, doc: Record<string, unknown>) => Promise<void>;
  query: (table: "idempotencyRecords" | "bidRefunds" | "ledgerEntries") => {
    withIndex: (
      name: string,
      fn: (q: RefundIndexBuilder) => RefundIndexBuilder,
    ) => { unique: () => Promise<RefundDbRow | null> };
  };
};

/** Chainable index-range builder shape (structural; real ctx and fakes satisfy it). */
export type RefundIndexBuilder = {
  eq: (field: string, value: unknown) => RefundIndexBuilder;
};

export type RefundCtx = RefundDb & IdempotencyCtx & AuditCtx & WalletCtx;

export type RefundBidInput = {
  auctionId: Id<"auctions">;
  bidId: Id<"bids">;
  /** Server clock (TRD §17) from the worker mutation. */
  now: number;
};

export type RefundBidResult =
  | { ok: true; status: "refunded"; bidRefundId: Id<"bidRefunds">; entryId: Id<"ledgerEntries"> }
  | { ok: true; status: "already_refunded"; bidRefundId: Id<"bidRefunds"> | null }
  | { ok: true; status: "replay"; bidRefundId: Id<"bidRefunds"> | null }
  | { ok: false; status: "refused"; reason: "bid_not_found" | "invalid_fee" | "not_accepted" };

/* ── Fee outcome envelope (written by the Phase H bid path) ── */

export type FeeOutcomeEnvelope = {
  bidId: string;
  ledgerEntryId: string;
  antiSnipeNewCloseAt: number | null;
  /** Exact provenance the fee consumed: lot → amount records. */
  allocations?: Array<{ lotId: string; amountSantim: number }>;
};

/** Read the fee's exact lot allocations from the fee ledger entry's idempotency outcome. */
export async function loadFeeAllocations(
  ctx: RefundCtx,
  input: { auctionId: Id<"auctions">; bidId: Id<"bids"> },
): Promise<Array<{ lotId: Id<"provenanceLots">; amountSantim: number }>> {
  const db = ctx.db as RefundDb;
  const feeEntry = await db
    .query("ledgerEntries")
    .withIndex("by_ref", (q) => q.eq("refType", "bid").eq("refId", input.bidId))
    .unique();
  if (feeEntry === null) return [];
  const record = await db
    .query("idempotencyRecords")
    .withIndex("by_key", (q) => q.eq("key", (feeEntry as RefundDbRow).idempotencyKey as string))
    .unique();
  if (record === null) return [];
  const envelope = decodeOutcome((record as RefundDbRow).outcome as string);
  if (envelope === null) return [];
  try {
    const parsed = JSON.parse(envelope.outcome as string) as FeeOutcomeEnvelope;
    return (parsed.allocations ?? []).map((a) => ({
      lotId: a.lotId as Id<"provenanceLots">,
      amountSantim: a.amountSantim,
    }));
  } catch {
    return [];
  }
}

/* ── The per-bid engine ── */

export async function refundBid(
  ctx: RefundCtx,
  input: RefundBidInput,
): Promise<RefundBidResult> {
  const db = ctx.db as RefundDb;

  const bid = (await db.get(input.bidId)) as RefundDbRow | null;
  if (bid === null) return { ok: false, status: "refused", reason: "bid_not_found" };

  // ── System-owned idempotency: key derives from the bid id alone — the
  //    worker runs without any user identity, and replay protection must
  //    never depend on one (frozen plan §13). ──
  const key = deriveIdempotencyKey({
    op: "refund",
    userId: null,
    clientToken: `bidref:${input.bidId}`,
  });
  const fingerprint = fingerprintRequest({
    bidId: input.bidId,
    auctionId: input.auctionId,
  });

  const checked = await checkIdempotencyKey(ctx, { key, fingerprint });
  if (checked.status === "replay") {
    // Original outcome verbatim, zero new effect.
    let priorId: Id<"bidRefunds"> | null = null;
    const prior = await db
      .query("bidRefunds")
      .withIndex("by_bid", (q) => q.eq("bidId", input.bidId))
      .unique();
    if (prior !== null) priorId = prior._id as Id<"bidRefunds">;
    return { ok: true, status: "replay", bidRefundId: priorId };
  }
  if (checked.status === "conflict") {
    // A refund attempt for the same bid with a different fingerprint is an
    // invariant violation — abort (zero effect).
    throw new Error(`refund idempotency conflict for bid ${input.bidId}`);
  }

  // ── Per-bid guard: ACCEPTED + not_refundable + positive fee. An
  //    already-refunded bid replays as a clean no-op (frozen plan §9:
  //    "already-refunded bids may safely replay as no-ops"). ──
  const feeSantim = bid.feeSantim as number;
  const eligibility = evaluateRefundEligibility({
    bidStatus: bid.status as string,
    refundStatus: bid.refundStatus as string,
    feeSantim,
  });
  if (!eligibility.ok) {
    if (eligibility.reason === "already_refunded") {
      const prior = await db
        .query("bidRefunds")
        .withIndex("by_bid", (q) => q.eq("bidId", input.bidId))
        .unique();
      return {
        ok: true,
        status: "already_refunded",
        bidRefundId: prior !== null ? (prior._id as Id<"bidRefunds">) : null,
      };
    }
    return {
      ok: false,
      status: "refused",
      reason: eligibility.reason === "not_accepted" ? "not_accepted" : "invalid_fee",
    };
  }

  // ── Restore the EXACT provenance the fee consumed ──
  const allocations = await loadFeeAllocations(ctx, {
    auctionId: input.auctionId,
    bidId: input.bidId,
  });
  if (allocations.length === 0) {
    // Every accepted bid's fee consumed lots (lockstep by construction);
    // a missing envelope is an invariant violation — abort (zero effect).
    throw new Error(`missing provenance envelope for bid ${input.bidId}`);
  }
  const restored = await restoreProvenanceLots(ctx, {
    ownerUserId: bid.bidderId as Id<"users">,
    records: allocations.map((a) => ({ lotId: a.lotId, amountSantim: a.amountSantim })),
  });
  if (!restored.ok) {
    // Over-restoration or mismatch is an invariant failure — abort.
    throw new Error(`provenance restoration failed: ${restored.reason}`);
  }

  // ── Credit the bidder's wallet (journal kind "refund", distinct class) ──
  const posted = await postWalletTransaction(ctx, {
    kind: "refund",
    refType: "bid",
    refId: input.bidId,
    walletLegs: [
      {
        userId: bid.bidderId as Id<"users">,
        deltaSantim: feeSantim,
        provenanceLotIds: allocations.map((a) => a.lotId),
      },
    ],
    counterpartPostings: [
      {
        account: "platform:bid_fee_revenue",
        direction: "debit",
        amountSantim: feeSantim,
      },
    ],
    ownerUserId: bid.bidderId as Id<"users">,
    idempotencyToken: key,
    idempotencyOp: "refund",
  });
  if (!posted.ok || posted.status !== "posted") {
    // Replay/conflict here is unreachable (checked above); any refusal is
    // an invariant violation — abort (zero effect; nothing was restored
    // because the whole transaction aborts).
    throw new Error(
      `refund wallet post refused: ${posted.ok ? posted.status : posted.reason}`,
    );
  }

  // ── bidRefunds row (by_bid unique — structural exactly-once) ──
  const bidRefundId = (await db.insert("bidRefunds", {
    bidId: input.bidId,
    auctionId: input.auctionId,
    bidderId: bid.bidderId,
    feeSantim,
    provenanceLotIds: allocations.map((a) => a.lotId),
    ledgerEntryId: posted.entryId,
    refundedAt: input.now,
    idempotencyKey: key,
  })) as Id<"bidRefunds">;

  // ── Mark the bid refunded ──
  await db.patch(input.bidId, { refundStatus: "refunded" });

  // ── Audit (system-attributed) + idempotency commit — same transaction ──
  await recordAuditEvent(ctx, {
    actorId: null,
    actorRole: "system",
    action: "refund.credited",
    entityType: "bidRefunds",
    entityId: bidRefundId,
    idempotencyKey: key,
    amountSantim: feeSantim,
    meta: {
      auctionId: input.auctionId,
      bidId: input.bidId,
      bidderId: bid.bidderId,
      ledgerEntryId: posted.entryId,
      provenanceLotIds: allocations.map((a) => a.lotId),
    },
  });
  await commitIdempotencyKey(ctx, {
    key,
    op: "refund",
    userId: null,
    fingerprint,
    refType: "bidRefunds",
    refId: bidRefundId,
    outcome: JSON.stringify({ bidRefundId, ledgerEntryId: posted.entryId }),
  });

  return { ok: true, status: "refunded", bidRefundId, entryId: posted.entryId };
}
