/**
 * LUBA V1 — settlement domain (Phase I pure cores, frozen plan §4/§6/§11).
 *
 * Deterministic, side-effect-free decisions consumed by the Convex workers:
 *   - settlement-campaign cross-field validity (frozen freeze gate #1),
 *   - legality decisions for settle / void / terminalization,
 *   - the isDone-gated terminalization decision,
 *   - campaign-creation replay/conflict classification.
 *
 * The deadline accessor contract lives in `settlementConfig.ts` (server);
 * the fail-closed production behavior is composed there. No I/O, no ctx,
 * no business policy invented.
 */
import type { CampaignKind, CampaignTrigger } from "./contracts";
import { requireAuctionTransition } from "./rules";

/* ── Campaign creation/validation (frozen freeze gate #1) ── */

export type CampaignValidation =
  | { ok: true }
  | { ok: false; reason: "invalid_trigger" };

/**
 * winner_determination ⇒ trigger ABSENT; bid_refunds ⇒ trigger REQUIRED and
 * valid. Enforced before any write at every creation site.
 */
export function evaluateCampaignValidity(input: {
  kind: CampaignKind;
  trigger?: CampaignTrigger;
}): CampaignValidation {
  if (input.kind === "winner_determination") {
    if (input.trigger !== undefined) return { ok: false, reason: "invalid_trigger" };
    return { ok: true };
  }
  if (input.trigger !== "no_winner" && input.trigger !== "settlement_void") {
    return { ok: false, reason: "invalid_trigger" };
  }
  return { ok: true };
}

/* ── Campaign-creation uniqueness classification ── */

export type CampaignCreationDecision =
  | { action: "insert" }
  | { action: "replay" }
  | { action: "conflict" };

/**
 * Given an existing campaign for `(auctionId, kind)` (or null), decide the
 * creation outcome. Existing row ⇒ replay (the concurrent creator's landing
 * spot after OCC restart); callers never overwrite or duplicate.
 */
export function evaluateCampaignCreation(existing: {
  status: string;
  trigger?: CampaignTrigger;
  kind: CampaignKind;
} | null): CampaignCreationDecision {
  if (existing === null) return { action: "insert" };
  return { action: "replay" };
}

/* ── Settle legality (frozen plan §9) ── */

export type SettleDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "auction_not_found"
        | "not_closed"
        | "result_not_winner"
        | "not_the_winner"
        | "phone_not_verified"
        | "deadline_missing"
        | "deadline_expired"
        | "settlement_not_pending"
        | "idempotency_conflict";
    };

/**
 * Pure settle guard. Callers run this after loading server truth; a refusal
 * precedes every write (zero economic effect).
 */
export function evaluateSettleEligibility(input: {
  auctionFound: boolean;
  auctionStatus: string;
  result: string | null;
  winningBidderId: IdLike;
  callerId: IdLike | null;
  phoneVerified: boolean;
  settlementDeadline: number | null;
  settlementRecordStatus: string | null;
  now: number;
}): SettleDecision {
  if (!input.auctionFound) return { ok: false, reason: "auction_not_found" };
  if (input.auctionStatus !== "CLOSED") return { ok: false, reason: "not_closed" };
  if (input.result !== "WINNER") return { ok: false, reason: "result_not_winner" };
  if (input.settlementRecordStatus !== "pending") {
    return { ok: false, reason: "settlement_not_pending" };
  }
  if (input.winningBidderId !== input.callerId) return { ok: false, reason: "not_the_winner" };
  if (!input.phoneVerified) return { ok: false, reason: "phone_not_verified" };
  if (input.settlementDeadline === null) return { ok: false, reason: "deadline_missing" };
  if (input.now > input.settlementDeadline) return { ok: false, reason: "deadline_expired" };
  return { ok: true };
}

type IdLike = string;

/* ── Void sweep legality (frozen plan §10) ── */

export type VoidDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "auction_not_found"
        | "not_closed"
        | "not_pending"
        | "deadline_not_expired";
    };

/**
 * Deadline-void guard: CLOSED + pending + past deadline. Guarded re-fire
 * (already voided, campaign exists) is handled by the worker via this same
 * shape — `not_pending` on a voided record is the replay landing spot.
 */
export function evaluateVoidEligibility(input: {
  auctionFound: boolean;
  auctionStatus: string;
  settlementRecordStatus: string | null;
  settlementDeadline: number | null;
  now: number;
}): VoidDecision {
  if (!input.auctionFound) return { ok: false, reason: "auction_not_found" };
  if (input.auctionStatus !== "CLOSED") return { ok: false, reason: "not_closed" };
  if (input.settlementRecordStatus !== "pending") return { ok: false, reason: "not_pending" };
  if (input.settlementDeadline === null) return { ok: false, reason: "deadline_not_expired" };
  if (input.now <= input.settlementDeadline) return { ok: false, reason: "deadline_not_expired" };
  return { ok: true };
}

/* ── Refund-chunk terminalization (frozen plan §11, isDone-gated) ── */

export type TerminalizationDecision =
  | { action: "settle" }
  | { action: "continue" };

/**
 * ONLY a final page (`isDone === true`) may settle. The immutable post-close
 * accepted-bid set (bid path refuses `too_late` at/after closeAt) makes
 * `isDone` mean "the entire authoritative accepted-bid set has been
 * traversed" — no separate completion query exists or is needed.
 */
export function evaluateTerminalization(input: { isDone: boolean; campaignStatus: string }): TerminalizationDecision {
  if (input.campaignStatus !== "in_progress") return { action: "continue" };
  return input.isDone ? { action: "settle" } : { action: "continue" };
}

/* ── Refund-bid eligibility ── */

export type RefundBidDecision =
  | { ok: true }
  | { ok: false; reason: "already_refunded" | "not_accepted" | "invalid_fee" };

/**
 * Per-bid refund guard (frozen plan §9): only ACCEPTED, not-yet-refunded
 * bids with a positive recorded fee are refundable. Already-refunded bids
 * replay as no-ops through this guard (the chunk engine checks the same
 * state before each bid).
 */
export function evaluateRefundEligibility(input: {
  bidStatus: string;
  refundStatus: string;
  feeSantim: number;
}): RefundBidDecision {
  if (input.bidStatus !== "ACCEPTED") return { ok: false, reason: "not_accepted" };
  if (input.refundStatus !== "not_refundable") return { ok: false, reason: "already_refunded" };
  if (!Number.isInteger(input.feeSantim) || input.feeSantim <= 0) {
    return { ok: false, reason: "invalid_fee" };
  }
  return { ok: true };
}

/* ── Lifecycle glue (composed, never redefined) ── */

/**
 * CLOSED → SETTLED legality via the Phase B frozen state machine — composed
 * here so both terminalization paths (settle and refund-final-chunk) go
 * through one evaluation.
 */
export function evaluateSettledTransition(currentStatus: string) {
  // The Phase B state machine's closed AuctionStatus union; the callers pass
  // persisted rows whose status is schema-validated to that union.
  return requireAuctionTransition(currentStatus as never, "SETTLED");
}
