/**
 * LUBA V1 — pure auction decision cores (Phase G foundation).
 *
 * Deterministic, side-effect-free evaluation for operator configuration,
 * server-time lifecycle guards, anti-snipe evaluation, and public
 * projections. The FROZEN lifecycle state machine itself (TRD §9:
 * DRAFT → SCHEDULED → OPEN → CLOSED → SETTLED, no CLOSING state) is the
 * Phase B `rules.ts` model — composed here, never redefined.
 *
 * Server-authoritative time (TRD §17): every eligibility check takes `now`
 * (the server/transaction clock) as a parameter. No helper ever reads a
 * client-supplied time; the Convex surface passes `Date.now()` only.
 *
 * Configuration fields (Backend Schema §8):
 *  - feeSantim / minBidSantim / maxBidSantim are OPEN business values —
 *    accepted ONLY as explicit operator configuration, structurally
 *    validated when present, never defaulted;
 *  - anti-snipe parameters are OPEN — the whole triple must be set
 *    together for anti-snipe to be active (partial config is rejected);
 *    unset ⇒ anti-snipe inactive;
 *  - settlementDeadline is NOT a creation/config input: it is set only at
 *    finalization when a winner exists (TRD §11), and its duration remains
 *    OPEN — accepting it here would silently resolve an OPEN decision.
 */
import type { Id } from "../_generated/dataModel";

import type { AuctionStatus, FulfillmentMethod } from "./contracts";
import { FULFILLMENT_METHODS } from "./contracts";
import { requireAuctionTransition } from "./rules";
import { isPositiveSantim, validateSantim } from "./money";
import { projectPublic } from "../guards/projections";

/* ── Result convention ── */

export type AuctionRejection =
  | "invalid_code"
  | "invalid_title"
  | "invalid_description"
  | "invalid_close_time"
  | "invalid_start_time"
  | "invalid_fulfillment_method"
  | "invalid_bounds"
  | "invalid_fee"
  | "invalid_antisnipe_config"
  | "invalid_blind_mode"
  | "illegal_transition"
  | "too_early"
  | "too_late"
  | "antisnipe_inactive"
  | "antisnipe_exhausted";

function fail<const R extends AuctionRejection>(reason: R): { ok: false; reason: R } {
  return { ok: false, reason };
}

/* ── 1. Configuration ── */

export type AuctionConfigInput = {
  /** Unique public auction code (mono display). */
  code: string;
  title: string;
  description?: string;
  prizeId: Id<"prizes">;
  /** Authoritative close time — UTC epoch millis, strictly future at config time. */
  closeAt: number;
  /** Optional scheduled start — future, strictly before closeAt. */
  startAt?: number;
  fulfillmentMethod: FulfillmentMethod;
  pickupDetails?: string;
  /** OPEN — accepted only as explicit operator configuration. */
  feeSantim?: number;
  /** OPEN — bounds validated structurally when present. */
  minBidSantim?: number;
  maxBidSantim?: number;
  /** OPEN — all three must be set together; unset ⇒ anti-snipe inactive. */
  antiSnipeWindowMs?: number;
  antiSnipeExtendMs?: number;
  antiSnipeMaxExtensions?: number;
};

export type AuctionRowDraft = {
  code: string;
  title: string;
  description?: string;
  prizeId: Id<"prizes">;
  closeAt: number;
  startAt?: number;
  fulfillmentMethod: FulfillmentMethod;
  pickupDetails?: string;
  feeSantim?: number;
  minBidSantim?: number;
  maxBidSantim?: number;
  antiSnipeWindowMs?: number;
  antiSnipeExtendMs?: number;
  antiSnipeMaxExtensions?: number;
};

export type AuctionConfigEvaluation =
  | { ok: true; row: AuctionRowDraft }
  | { ok: false; reason: AuctionRejection };

/** Positive-integer-millis check for optional anti-snipe parameters. */
function isPositiveMillis(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/**
 * Validate operator auction configuration. `now` is the SERVER clock
 * (TRD §17) — a configuration whose authoritative close time is not in the
 * future is refused before any write. `blindMode` is always true in V1
 * (structural marker of the blind rule) and is not an operator choice.
 */
export function evaluateAuctionConfig(
  input: AuctionConfigInput,
  now: number,
): AuctionConfigEvaluation {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (code.length === 0 || code.length > 64 || /\s/.test(code)) {
    return fail("invalid_code");
  }
  if (
    typeof input.title !== "string" ||
    input.title.trim().length === 0 ||
    input.title.length > 200
  ) {
    return fail("invalid_title");
  }
  if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2000)) {
    return fail("invalid_description");
  }
  if (!Number.isInteger(input.closeAt) || input.closeAt <= now) {
    return fail("invalid_close_time");
  }
  if (
    input.startAt !== undefined &&
    (!Number.isInteger(input.startAt) || input.startAt < now || input.startAt >= input.closeAt)
  ) {
    return fail("invalid_start_time");
  }
  if (!(FULFILLMENT_METHODS as readonly string[]).includes(input.fulfillmentMethod)) {
    return fail("invalid_fulfillment_method");
  }
  if (input.feeSantim !== undefined && !isPositiveSantim(input.feeSantim)) {
    return fail("invalid_fee");
  }
  if (input.minBidSantim !== undefined && !validateSantim(input.minBidSantim).ok) {
    return fail("invalid_bounds");
  }
  if (input.maxBidSantim !== undefined && !validateSantim(input.maxBidSantim).ok) {
    return fail("invalid_bounds");
  }
  if (
    input.minBidSantim !== undefined &&
    input.maxBidSantim !== undefined &&
    input.minBidSantim > input.maxBidSantim
  ) {
    return fail("invalid_bounds");
  }
  // Anti-snipe: all-or-nothing. Unset ⇒ inactive; partially set ⇒ refuse.
  const antiSnipeSet = [input.antiSnipeWindowMs, input.antiSnipeExtendMs, input.antiSnipeMaxExtensions].filter(
    (v) => v !== undefined,
  ).length;
  if (antiSnipeSet !== 0 && antiSnipeSet !== 3) {
    return fail("invalid_antisnipe_config");
  }
  if (
    antiSnipeSet === 3 &&
    (!isPositiveMillis(input.antiSnipeWindowMs) ||
      !isPositiveMillis(input.antiSnipeExtendMs) ||
      !isPositiveMillis(input.antiSnipeMaxExtensions))
  ) {
    return fail("invalid_antisnipe_config");
  }

  return {
    ok: true,
    row: {
      code,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      prizeId: input.prizeId,
      closeAt: input.closeAt,
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      fulfillmentMethod: input.fulfillmentMethod,
      ...(input.pickupDetails !== undefined ? { pickupDetails: input.pickupDetails } : {}),
      ...(input.feeSantim !== undefined ? { feeSantim: input.feeSantim } : {}),
      ...(input.minBidSantim !== undefined ? { minBidSantim: input.minBidSantim } : {}),
      ...(input.maxBidSantim !== undefined ? { maxBidSantim: input.maxBidSantim } : {}),
      ...(input.antiSnipeWindowMs !== undefined
        ? {
            antiSnipeWindowMs: input.antiSnipeWindowMs,
            antiSnipeExtendMs: input.antiSnipeExtendMs,
            antiSnipeMaxExtensions: input.antiSnipeMaxExtensions,
          }
        : {}),
    },
  };
}

/** Fields an operator may re-configure while the auction is still DRAFT. */
export const UPDATABLE_AUCTION_FIELDS = [
  "title",
  "description",
  "closeAt",
  "startAt",
  "fulfillmentMethod",
  "pickupDetails",
  "feeSantim",
  "minBidSantim",
  "maxBidSantim",
  "antiSnipeWindowMs",
  "antiSnipeExtendMs",
  "antiSnipeMaxExtensions",
] as const;

export type AuctionPatchEvaluation =
  | { ok: true; patch: Partial<AuctionRowDraft> }
  | { ok: false; reason: AuctionRejection };

/**
 * Evaluate a DRAFT-stage configuration update. `code` and `prizeId` are
 * immutable (public identity and the reservation's binding); status,
 * resultDeterminedAt, settlementDeadline, and extensionCount are
 * server-owned and can never appear in a config patch. Anti-snipe and
 * bounds values re-validate structurally against the server clock.
 */
export function evaluateAuctionConfigPatch(
  patch: Record<string, unknown>,
  now: number,
): AuctionPatchEvaluation {
  if ("code" in patch || "prizeId" in patch) return fail("invalid_code");
  const out: Partial<AuctionRowDraft> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!(UPDATABLE_AUCTION_FIELDS as readonly string[]).includes(field)) {
      return fail("invalid_title");
    }
    if (value === undefined) continue;
    if (field === "closeAt") {
      if (!Number.isInteger(value) || (value as number) <= now) return fail("invalid_close_time");
      out.closeAt = value as number;
      continue;
    }
    if (field === "startAt") {
      if (!Number.isInteger(value) || (value as number) < now) return fail("invalid_start_time");
      out.startAt = value as number;
      continue;
    }
    if (field === "feeSantim") {
      if (!isPositiveSantim(value as number)) return fail("invalid_fee");
      out.feeSantim = value as number;
      continue;
    }
    if (field === "minBidSantim" || field === "maxBidSantim") {
      if (!validateSantim(value as number).ok) return fail("invalid_bounds");
      (out as Record<string, unknown>)[field] = value;
      continue;
    }
    if (field === "antiSnipeWindowMs" || field === "antiSnipeExtendMs" || field === "antiSnipeMaxExtensions") {
      if (!isPositiveMillis(value as number)) return fail("invalid_antisnipe_config");
      (out as Record<string, unknown>)[field] = value;
      continue;
    }
    if (field === "title") {
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
        return fail("invalid_title");
      }
      out.title = value;
      continue;
    }
    if (field === "description") {
      if (typeof value !== "string" || value.length > 2000) return fail("invalid_description");
      out.description = value;
      continue;
    }
    if (field === "fulfillmentMethod") {
      if (!(FULFILLMENT_METHODS as readonly string[]).includes(value as string)) {
        return fail("invalid_fulfillment_method");
      }
      out.fulfillmentMethod = value as FulfillmentMethod;
      continue;
    }
    if (field === "pickupDetails") {
      if (typeof value !== "string") return fail("invalid_title");
      out.pickupDetails = value;
    }
  }
  // Bounds sanity across the merged result.
  const min = out.minBidSantim;
  const max = out.maxBidSantim;
  if (min !== undefined && max !== undefined && min > max) return fail("invalid_bounds");
  return { ok: true, patch: out };
}

/* ── 2. Server-time lifecycle eligibility (guards live in mutations) ── */

export type EligibilityEvaluation =
  | { ok: true }
  | { ok: false; reason: "illegal_transition" | "too_early" | "too_late" };

/**
 * Publish eligibility (DRAFT → SCHEDULED): state machine only — the
 * inventory reservation gate is verified server-side by the mutation.
 */
export function evaluatePublishEligibility(status: AuctionStatus): EligibilityEvaluation {
  const transition = requireAuctionTransition(status, "SCHEDULED");
  if (!transition.ok) return { ok: false, reason: "illegal_transition" };
  return { ok: true };
}

/**
 * Open eligibility (SCHEDULED → OPEN): state machine + server-time guard.
 * Operator manual open ignores `startAt` ("may also be opened when
 * appropriate by the operator", TRD §9) but can never open at/after the
 * authoritative close time — that auction is already over by the clock.
 */
export function evaluateOpenEligibility(input: {
  status: AuctionStatus;
  closeAt: number;
  now: number;
}): EligibilityEvaluation {
  const transition = requireAuctionTransition(input.status, "OPEN");
  if (!transition.ok) return { ok: false, reason: "illegal_transition" };
  if (input.now >= input.closeAt) return { ok: false, reason: "too_late" };
  return { ok: true };
}

/**
 * Backstop open eligibility (scheduled sweep): opens only when the
 * configured start time has arrived on the server clock.
 */
export function evaluateSweepOpenEligibility(input: {
  startAt: number | undefined;
  closeAt: number;
  now: number;
}): EligibilityEvaluation {
  if (input.startAt === undefined) return { ok: false, reason: "too_early" };
  if (input.now < input.startAt) return { ok: false, reason: "too_early" };
  if (input.now >= input.closeAt) return { ok: false, reason: "too_late" };
  return { ok: true };
}

/**
 * Close eligibility (OPEN → CLOSED): state machine + server-time guard.
 * Closing is time-driven (TRD §9/§17) — an early close is refused; the
 * authoritative close time can move ONLY via anti-snipe extension.
 */
export function evaluateCloseEligibility(input: {
  status: AuctionStatus;
  closeAt: number;
  now: number;
}): EligibilityEvaluation {
  const transition = requireAuctionTransition(input.status, "CLOSED");
  if (!transition.ok) return { ok: false, reason: "illegal_transition" };
  if (input.now < input.closeAt) return { ok: false, reason: "too_early" };
  return { ok: true };
}

/**
 * Display-only derived state for queries (TRD §9: queries may compute
 * display status, never mutate). When the server clock has passed an OPEN
 * auction's close time but the backstop has not yet finalized it, clients
 * render "bidding has ended" — no lifecycle state changes.
 */
export function deriveDisplayStatus(input: {
  status: AuctionStatus;
  closeAt: number;
  now: number;
}): { status: AuctionStatus; biddingEnded: boolean } {
  return {
    status: input.status,
    biddingEnded: input.status === "OPEN" && input.now >= input.closeAt,
  };
}

/* ── 3. Anti-snipe evaluation (TRD §18) ── */

export type AntiSnipeEvaluation =
  | { ok: true; active: false }
  | { ok: true; active: true; newCloseAt: number }
  | { ok: false; reason: AuctionRejection };

/**
 * Should THIS instant trigger an anti-snipe extension? Deterministic
 * (TRD §18 FROZEN): given the same bid sequence, extensions are
 * reproducible and bounded by the configured maximum.
 *  - any parameter unset ⇒ inactive (anti-snipe stays OFF);
 *  - trigger applies from server time: `now` within the trigger window
 *    before the authoritative close time (and strictly before it);
 *  - bounded: no extension beyond `antiSnipeMaxExtensions`;
 *  - the extension ADDS `antiSnipeExtendMs` to the authoritative closeAt.
 */
export function evaluateAntiSnipeExtension(input: {
  now: number;
  closeAt: number;
  antiSnipeWindowMs: number | undefined;
  antiSnipeExtendMs: number | undefined;
  antiSnipeMaxExtensions: number | undefined;
  extensionCount: number;
}): AntiSnipeEvaluation {
  const { antiSnipeWindowMs, antiSnipeExtendMs, antiSnipeMaxExtensions } = input;
  if (
    antiSnipeWindowMs === undefined ||
    antiSnipeExtendMs === undefined ||
    antiSnipeMaxExtensions === undefined
  ) {
    return { ok: true, active: false };
  }
  if (input.extensionCount >= antiSnipeMaxExtensions) {
    return { ok: false, reason: "antisnipe_exhausted" };
  }
  const windowStart = input.closeAt - antiSnipeWindowMs;
  if (input.now < windowStart || input.now >= input.closeAt) {
    return { ok: true, active: false };
  }
  return { ok: true, active: true, newCloseAt: input.closeAt + antiSnipeExtendMs };
}

/* ── 4. Public projections (Backend Schema §18.1) ── */

/** Public listing visibility: DRAFT and CLOSED-internal are never listed. */
export function isPubliclyVisibleStatus(status: AuctionStatus): boolean {
  return status === "SCHEDULED" || status === "OPEN" || status === "SETTLED";
}

const PUBLIC_AUCTION_SUMMARY_FIELDS = [
  "code",
  "title",
  "status",
  "startAt",
  "closeAt",
  "fulfillmentMethod",
  "feeSantim",
] as const;

export type PublicAuctionSummary = {
  code: string;
  title: string;
  status: AuctionStatus;
  startAt: number | undefined;
  closeAt: number;
  fulfillmentMethod: FulfillmentMethod;
  /** Present only when the OPEN fee configuration exists. */
  feeSantim: number | undefined;
  prize: { title: string; image: string | null };
};

/**
 * Catalog-card projection (Backend Schema §18.1): card fields + prize
 * summary/primary image. Operator configuration (anti-snipe, bounds) and
 * all bid internals are structurally absent. Built through the Phase B
 * whitelist picker.
 */
export function projectPublicAuctionSummary(input: {
  auction: {
    code: string;
    title: string;
    status: AuctionStatus;
    startAt?: number;
    closeAt: number;
    fulfillmentMethod: FulfillmentMethod;
    feeSantim?: number;
  };
  prize: { title: string; images?: readonly string[] | null };
}): PublicAuctionSummary {
  const projected = projectPublic(input.auction, PUBLIC_AUCTION_SUMMARY_FIELDS);
  const images = input.prize.images ?? [];
  return {
    code: projected.code as string,
    title: projected.title as string,
    status: projected.status as AuctionStatus,
    startAt: projected.startAt as number | undefined,
    closeAt: projected.closeAt as number,
    fulfillmentMethod: projected.fulfillmentMethod as FulfillmentMethod,
    feeSantim: projected.feeSantim as number | undefined,
    prize: {
      title: input.prize.title,
      image: images.length > 0 ? images[0] : null,
    },
  };
}

export type PublicAuctionDetail = PublicAuctionSummary & {
  description: string | undefined;
  /** OPEN live-detail bounds — present only when configured (§18.1). */
  minBidSantim: number | undefined;
  maxBidSantim: number | undefined;
};

/**
 * Live auction detail (Backend Schema §18.1): card fields + countdown
 * source (closeAt) + bounds ONLY when configured. Never: other bids,
 * distribution, counters, uniqueness data, ranking, current winner,
 * lowest-unique value — no such field exists to leak (§18.4).
 */
export function projectPublicAuctionDetail(input: {
  auction: {
    code: string;
    title: string;
    description?: string;
    status: AuctionStatus;
    startAt?: number;
    closeAt: number;
    fulfillmentMethod: FulfillmentMethod;
    feeSantim?: number;
    minBidSantim?: number;
    maxBidSantim?: number;
  };
  prize: { title: string; images?: readonly string[] | null };
}): PublicAuctionDetail {
  const summary = projectPublicAuctionSummary(input);
  return {
    ...summary,
    description: input.auction.description,
    minBidSantim: input.auction.minBidSantim,
    maxBidSantim: input.auction.maxBidSantim,
  };
}
