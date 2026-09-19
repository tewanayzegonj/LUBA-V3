/**
 * LUBA V1 — pure domain validation helpers.
 *
 * Deterministic, side-effect-free checks over the closed contracts. Pure
 * functions only: no I/O, no DB access, no `ctx`, no Date.now, no Math.random.
 * State-guard mutations (Phase D+) call these; nothing here mutates anything.
 *
 * Authoritative state-machine definitions live in docs/luba-v1-trd.md:
 *   §9  auction lifecycle  DRAFT → SCHEDULED → OPEN → CLOSED → SETTLED
 *   §11 settlement phase model (settlement-pending inside CLOSED)
 *   §12 inventory          RESERVE → COMMIT | RELEASE
 *
 * OPEN decisions (fee amount/model, bid bounds, same-amount repeat rule,
 * anti-snipe values, settlement deadline, withdrawal policy) are NOT
 * encoded here — helpers take such values as parameters, never defaults.
 */
import type {
  AuctionStatus,
  ReservationResolution,
  ReservationStatus,
  SettlementStatus,
} from "./contracts";

import {
  BID_STATUSES,
  REJECTION_REASONS,
  RESERVATION_RESOLUTIONS,
  RESERVATION_STATUSES,
  SETTLEMENT_STATUSES,
} from "./contracts";

import {
  isNonNegativeSantim,
  validateSantim,
  type Santim,
} from "./money";

/* ── Result convention ──
 * Rejections carry a stable machine reason; `ok` results carry the value
 * the mutation layer needs. No prose strings, no throwing. */

export type RuleRejection =
  | "illegal_transition"
  | "illegal_reservation_status"
  | "illegal_resolution"
  | "illegal_settlement_status"
  | "terminal_state"
  | "invalid_amount"
  | "invalid_bounds"
  | "invalid_quantity"
  | "invalid_status"
  | "missing_status";

function fail<
  const R extends
    | RuleRejection
    | (typeof REJECTION_REASONS)[number]
    | "phone_missing"
    | "phone_unverified",
>(reason: R): { ok: false; reason: R } {
  return { ok: false, reason };
}

function ok<const T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/* ── Auction lifecycle — TRD §9 (FROZEN): DRAFT → SCHEDULED → OPEN →
 * CLOSED → SETTLED. No CLOSING state exists; settlement-pending is modeled
 * inside CLOSED (settlementRecords.status = "pending"). SETTLED is terminal.
 * ── */

export const LEGAL_AUCTION_TRANSITIONS: Readonly<
  Record<AuctionStatus, readonly AuctionStatus[]>
> = {
  DRAFT: ["SCHEDULED"],
  SCHEDULED: ["OPEN"],
  OPEN: ["CLOSED"],
  CLOSED: ["SETTLED"],
  SETTLED: [],
};

/**
 * Is `from → to` a legal lifecycle transition under the frozen state machine?
 * Guard mutations check this in-transaction before mutating.
 */
export function canTransitionAuction(
  from: AuctionStatus,
  to: AuctionStatus,
): boolean {
  return LEGAL_AUCTION_TRANSITIONS[from].includes(to);
}

/**
 * Strict forward transition: rejects self-transitions and terminal states.
 * Use when the mutation must move to a *different* status.
 */
export function requireAuctionTransition(
  from: AuctionStatus,
  to: AuctionStatus,
): { ok: true } | { ok: false; reason: RuleRejection } {
  if (from === to) return fail("illegal_transition");
  if (!canTransitionAuction(from, to)) return fail("illegal_transition");
  return ok({ ok: true } as const);
}

/* ── Inventory — RESERVE → COMMIT | RELEASE (Backend Schema §7.2) ──
 * RESERVE creates `reserved`. COMMIT and RELEASE apply only from
 * `reserved`. `cancelled` applies only before the auction ever opens.
 * `committed` and `released` are terminal for the reservation row. */

export type InventoryAction = "COMMIT" | "RELEASE" | "CANCEL";

const LEGAL_INVENTORY_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly InventoryAction[]>
> = {
  reserved: ["COMMIT", "RELEASE", "CANCEL"],
  committed: [],
  released: [],
  cancelled: [],
};

/** Is applying `action` to a reservation in `status` legal? */
export function canApplyInventoryAction(
  status: ReservationStatus,
  action: InventoryAction,
): boolean {
  return LEGAL_INVENTORY_TRANSITIONS[status].includes(action);
}

/**
 * Reservation resolution must match the action taken. COMMIT ⇒ "settlement";
 * RELEASE ⇒ "void" | "no_winner"; CANCEL ⇒ "cancel_before_open".
 */
export function requireResolutionForInventoryAction(
  action: InventoryAction,
  resolution: ReservationResolution,
): { ok: true } | { ok: false; reason: RuleRejection } {
  const legal: Readonly<Record<InventoryAction, readonly ReservationResolution[]>> = {
    COMMIT: ["settlement"],
    RELEASE: ["void", "no_winner"],
    CANCEL: ["cancel_before_open"],
  };
  if (!legal[action].includes(resolution)) return fail("illegal_resolution");
  return ok({ ok: true } as const);
}

/* ── Settlement — Backend Schema §11.1 (TRD §11 phase model) ──
 * `pending` = CLOSED-with-WINNER settlement window. `paid` ⇒ auction
 * SETTLED(WINNER). `voided` ⇒ SETTLED(NO_WINNER) with refunds. Terminal
 * states: paid, voided. A settled auction must carry exactly one terminal
 * settlement outcome. */

export const TERMINAL_SETTLEMENT_STATUSES: readonly SettlementStatus[] = [
  "paid",
  "voided",
];

/** Structural legality of a settlement status change. */
export function canTransitionSettlement(
  from: SettlementStatus,
  to: SettlementStatus,
): boolean {
  if (from === to) return false;
  if (TERMINAL_SETTLEMENT_STATUSES.includes(from)) return false;
  return SETTLEMENT_STATUSES.includes(to);
}

/**
 * Consistency of a CLOSED auction's settlement combination: a WINNER result
 * requires a settlement record in `pending`; SETTLED(WINNER) requires
 * `paid`; SETTLED(NO_WINNER) requires `voided`. Settlement records only
 * exist for WINNER outcomes — NO_WINNER-at-close produces refunds directly.
 */
export function requireSettlementConsistency(
  input: {
    auctionStatus: "CLOSED" | "SETTLED";
    result: "WINNER" | "NO_WINNER";
    settlementStatus: SettlementStatus | null;
  },
): { ok: true } | { ok: false; reason: RuleRejection } {
  const { auctionStatus, result, settlementStatus } = input;

  if (auctionStatus === "CLOSED") {
    if (result === "WINNER") {
      if (settlementStatus !== "pending") return fail("illegal_settlement_status");
      return ok({ ok: true } as const);
    }
    if (settlementStatus !== null) return fail("illegal_settlement_status");
    return ok({ ok: true } as const);
  }

  // SETTLED — exactly one deterministic terminal combination each.
  if (result === "WINNER") {
    if (settlementStatus !== "paid") return fail("illegal_settlement_status");
    return ok({ ok: true } as const);
  }
  if (settlementStatus !== "voided") return fail("illegal_settlement_status");
  return ok({ ok: true } as const);
}

/* ── Bid structural validation — Backend Schema §9 ──
 * Blind-bidding rules are structural: nothing here computes or reveals
 * uniqueness/duplication/ranking. Only *structural* checks: amount must be a
 * positive integer santim, and when bounds are configured they must be sane
 * and contain the amount. Fee is provided by the caller (server config);
 * its value stays OPEN. */

export type BidStructuralInput = {
  amountSantim: number;
  minBidSantim: number | null | undefined;
  maxBidSantim: number | null | undefined;
};

export type BidStructuralRejection = RuleRejection | (typeof REJECTION_REASONS)[number];

export function validateBidStructure(
  input: BidStructuralInput,
): { ok: true } | { ok: false; reason: BidStructuralRejection } {
  const amount = validateSantim(input.amountSantim);
  if (!amount.ok) return fail("invalid_amount");

  const { minBidSantim, maxBidSantim } = input;
  // Bounds sanity first — inverted bounds are a configuration error and must
  // be reported as such regardless of the submitted amount.
  if (
    minBidSantim != null &&
    maxBidSantim != null &&
    minBidSantim > maxBidSantim
  ) {
    return fail("invalid_bounds");
  }
  if (minBidSantim != null) {
    const min = validateSantim(minBidSantim);
    if (!min.ok) return fail("invalid_bounds");
    if (amount.value < min.value) return fail("out_of_range");
  }
  if (maxBidSantim != null) {
    const max = validateSantim(maxBidSantim);
    if (!max.ok) return fail("invalid_bounds");
    if (amount.value > max.value) return fail("out_of_range");
  }
  return ok({ ok: true } as const);
}

/** Closed-vocabulary membership checks for the bid path. */
export function isBidStatus(value: string): value is (typeof BID_STATUSES)[number] {
  return (BID_STATUSES as readonly string[]).includes(value);
}

export function isRejectionReason(value: string): value is (typeof REJECTION_REASONS)[number] {
  return (REJECTION_REASONS as readonly string[]).includes(value);
}

export function isReservationStatus(value: string): value is ReservationStatus {
  return (RESERVATION_STATUSES as readonly string[]).includes(value);
}

export function isReservationResolution(
  value: string,
): value is ReservationResolution {
  return (RESERVATION_RESOLUTIONS as readonly string[]).includes(value);
}

/** Inventory quantity for a reservation line: integer >= 1. */
export function validateReservationQuantity(
  quantity: number,
): { ok: true; value: number } | { ok: false; reason: RuleRejection } {
  if (!Number.isInteger(quantity) || quantity < 1) return fail("invalid_quantity");
  return ok(quantity);
}

/**
 * Wallet projection guard: an available balance must be a non-negative
 * integer santim. Availability checks use `hasAvailableSantim` — a bid or
 * settlement with insufficient balance is refused, never partially applied.
 */
export function validateWalletProjection(
  availableSantim: number,
): { ok: true; value: Santim } | { ok: false; reason: RuleRejection } {
  if (!isNonNegativeSantim(availableSantim)) return fail("invalid_amount");
  return ok(availableSantim);
}

/**
 * Verified-phone gate — FROZEN precondition for all financial participation
 * (Backend Schema §2: `phoneVerified` is the FROZEN gate for every economic
 * op). Fails closed: an absent/unknown verification flag is treated as NOT
 * verified. Pure check over caller-fetched user data.
 */
export type PhoneGateInput = {
  phone: string | null | undefined;
  phoneVerified: boolean | null | undefined;
};

export type PhoneGateRejection = RuleRejection | "phone_missing" | "phone_unverified";

export function requireVerifiedPhone(
  input: PhoneGateInput,
): { ok: true } | { ok: false; reason: PhoneGateRejection } {
  const { phone, phoneVerified } = input;
  if (typeof phone !== "string" || phone.length === 0) return fail("phone_missing");
  if (phoneVerified !== true) return fail("phone_unverified");
  return ok({ ok: true } as const);
}
