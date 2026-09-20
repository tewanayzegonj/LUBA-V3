/**
 * LUBA V1 — pure bid decision cores (Phase H).
 *
 * Deterministic, side-effect-free evaluation for bid submission: server-time
 * eligibility, structural amount/bounds validation (Phase B `rules.ts` is
 * composed, never redefined), configured-fee policy, and the user-owned bid
 * projection. No uniqueness, ranking, distribution, or winner logic exists
 * anywhere — blind bidding is structural (Backend Schema §9: no such field
 * is computed or stored).
 *
 * OPEN decisions (fee amount/model, min/max bid, duplicate-amount rule,
 * bid-volume cap) are taken as parameters — `null`/`undefined` means
 * "policy unset" and the decision FAILS SAFELY rather than defaulting:
 *  - an unset fee is `bid_fee_unconfigured` (the engine never bids for free);
 *  - bounds behave per Phase B `validateBidStructure` (unset ⇒ not enforced);
 *  - the duplicate-amount rule is UNSET in V1 ⇒ `duplicate_amount` is never
 *    emitted (Phase B frozen vocabulary, unused until decided);
 *  - no bid-volume cap exists in the frozen contract ⇒ none is evaluated.
 *
 * Server-authoritative time (TRD §17): every eligibility check compares
 * against the `now` passed from the mutation boundary — never client input.
 */
import type { AuctionStatus, BidStatus, RejectionReason } from "./contracts";
import { validateBidStructure } from "./rules";

/* ── 1. Server-time eligibility (TRD §17) ── */

export type BidTimeWindowInput = {
  status: AuctionStatus;
  startAt: number | undefined;
  closeAt: number;
  now: number;
};

export type BidTimeRejection =
  | "not_open"
  | "too_late";

/**
 * May a bid be considered against this auction at server time `now`?
 *  - only OPEN auctions accept bids (frozen lifecycle; no CLOSING state);
 *  - `now < startAt` is structurally impossible for an OPEN auction (the
 *    Phase G sweep opens it), but the guard still refuses it — fail closed;
 *  - at/after `closeAt` ⇒ `too_late` (the frozen rejection vocabulary);
 *    the close boundary itself is NOT bid-eligible (`now >= closeAt`).
 */
export function evaluateBidTimeWindow(
  input: BidTimeWindowInput,
): { ok: true } | { ok: false; reason: BidTimeRejection } {
  if (input.status !== "OPEN") return { ok: false, reason: "not_open" };
  if (input.startAt !== undefined && input.now < input.startAt) {
    return { ok: false, reason: "not_open" };
  }
  if (input.now >= input.closeAt) return { ok: false, reason: "too_late" };
  return { ok: true };
}

/* ── 2. Configured bid policy (all values OPEN — passed in, never defaulted) ── */

export type BidPolicyInput = {
  amountSantim: number;
  /** Per-auction configured bounds — unset means NOT enforced. */
  minBidSantim: number | null | undefined;
  maxBidSantim: number | null | undefined;
  /**
   * The per-auction configured fee in integer santims — the only fee model
   * V1's schema models. `null | undefined` ⇒ the fee policy is UNSET and
   * the bid MUST be refused (the engine never invents a fee).
   */
  feeSantim: number | null | undefined;
};

export type BidPolicyRejection =
  | "invalid_amount"
  | "invalid_bounds"
  | "out_of_range"
  | "bid_fee_unconfigured"
  | "invalid_fee_config";

/**
 * Validate the amount against the configured bounds (Phase B structural
 * rules) and resolve the fee. Fail-safe on unset fee policy.
 */
export function evaluateBidPolicy(
  input: BidPolicyInput,
): { ok: true; feeSantim: number } | { ok: false; reason: BidPolicyRejection } {
  const structure = validateBidStructure({
    amountSantim: input.amountSantim,
    minBidSantim: input.minBidSantim,
    maxBidSantim: input.maxBidSantim,
  });
  if (!structure.ok) {
    // Phase B reasons: invalid_amount | invalid_bounds | out_of_range.
    return { ok: false, reason: structure.reason as BidPolicyRejection };
  }
  if (input.feeSantim == null) {
    // OPEN decision unconfigured ⇒ fail safely; no default fee is invented.
    return { ok: false, reason: "bid_fee_unconfigured" };
  }
  if (!Number.isInteger(input.feeSantim) || input.feeSantim <= 0) {
    // A configured fee must itself be a positive integer santim.
    return { ok: false, reason: "invalid_fee_config" };
  }
  return { ok: true, feeSantim: input.feeSantim };
}

/* ── 3. Submission orchestration decision (transaction sequencing) ── */

export type BidSubmissionInput = {
  auctionStatus: AuctionStatus;
  startAt: number | undefined;
  closeAt: number;
  now: number;
  amountSantim: number;
  minBidSantim: number | null | undefined;
  maxBidSantim: number | null | undefined;
  feeSantim: number | null | undefined;
};

export type BidSubmissionDecision =
  | { ok: true; feeSantim: number }
  | { ok: false; reason: "not_open" | "too_late" | BidPolicyRejection };

/**
 * The complete pre-transaction decision: state/time gate, then policy.
 * Pure — the mutation layer runs authorization, idempotency, and the
 * economic effect around this core.
 */
export function evaluateBidSubmission(
  input: BidSubmissionInput,
): BidSubmissionDecision {
  const window = evaluateBidTimeWindow({
    status: input.auctionStatus,
    startAt: input.startAt,
    closeAt: input.closeAt,
    now: input.now,
  });
  if (!window.ok) return window;
  return evaluateBidPolicy({
    amountSantim: input.amountSantim,
    minBidSantim: input.minBidSantim,
    maxBidSantim: input.maxBidSantim,
    feeSantim: input.feeSantim,
  });
}

/* ── 4. Rejection persistence shape (frozen REJECTED rows are audit-only) ── */

/**
 * A rejected bid persists an audit/status row with the frozen closed-vocab
 * reason and NO economic effect. Only guard/reason classes that belong in
 * the frozen `REJECTION_REASONS` vocabulary are persistable; other failure
 * classes (authorization, unconfigured policy, idempotency) are returned
 * to the caller without a bid row — they are configuration/session errors,
 * not bid-path transactional statuses.
 */
export function isPersistableRejection(
  reason: string,
): reason is RejectionReason {
  return (
    reason === "insufficient_funds" ||
    reason === "too_late" ||
    reason === "out_of_range" ||
    reason === "duplicate_amount" ||
    reason === "rate_limited" ||
    reason === "not_open"
  );
}

/* ── 5. User-owned bid projection (Backend Schema §18.2 — blind-safe) ── */

export type OwnBid = {
  id: string;
  auctionId: string;
  amountSantim: number;
  feeSantim: number;
  status: BidStatus;
  rejectionReason: RejectionReason | undefined;
  refundStatus: "not_refundable" | "refunded" | "pending_refund";
  placedAt: number;
};

/**
 * Project ONE of the user's own bids. FROZEN self-visibility (PRD Q22):
 * own amount, own fee, transactional status, refund status. NEVER: whether
 * this bid was unique or duplicated, its rank, other bids, any live
 * distribution — none of those fields exist here to leak, and the
 * whitelist below is the projection boundary.
 */
export function projectOwnBid(row: {
  _id: string;
  auctionId: string;
  amountSantim: number;
  feeSantim: number;
  status: BidStatus;
  rejectionReason?: RejectionReason;
  refundStatus: "not_refundable" | "refunded" | "pending_refund";
  placedAt: number;
}): OwnBid {
  return {
    id: row._id,
    auctionId: row.auctionId,
    amountSantim: row.amountSantim,
    feeSantim: row.feeSantim,
    status: row.status,
    rejectionReason: row.rejectionReason,
    refundStatus: row.refundStatus,
    placedAt: row.placedAt,
  };
}
