/**
 * LUBA V1 — anti-abuse configuration (generic throttling ONLY).
 *
 * TRD OQ11: rate-limit threshold values are an OPEN decision. This module is
 * the ONLY read site for those thresholds; every value is null while OPEN —
 * the mechanism carries the seam, never a default (Implementation Plan §1.8:
 * OPEN ≠ configured). A null threshold means the guard is INACTIVE for that
 * subject; no limit is invented anywhere.
 *
 * `__setTestAbuseThresholds` is the test-only injection hook (same pattern as
 * the O1 settlement-deadline seam): isolated tests may install thresholds and
 * MUST remove them in a finally block. Production policy stays unconfigured.
 *
 * A future threshold freeze edits exactly this file — no call-site changes.
 */
import type { AbuseSubjectName } from "./domain/abuse";

export type AbuseThresholdConfig = {
  /** Max hits allowed per window per subject; null = OPEN ⇒ guard inactive. */
  threshold: number | null;
  /** Fixed window length in millis (engineering parameter, not policy). */
  windowMs: number;
};

/**
 * Per-subject configuration. Every threshold is null (OPEN — TRD OQ11);
 * windowMs values are engineering defaults for the fixed-window mechanism.
 * No product bid-volume cap exists here or anywhere: `bid_submit` throttling,
 * when ever configured, is a generic abuse throttle and never a cap on how
 * many bids a user may place over the auction lifetime.
 */
const THRESHOLDS: Record<AbuseSubjectName, AbuseThresholdConfig> = {
  otp_request: { threshold: null, windowMs: 60_000 },
  otp_verify: { threshold: null, windowMs: 60_000 },
  bid_submit: { threshold: null, windowMs: 60_000 },
  deposit_init: { threshold: null, windowMs: 60_000 },
  withdrawal_req: { threshold: null, windowMs: 60_000 },
};

/* ── Test-only injection (never a production default) ── */

type ThresholdOverride = Partial<Record<AbuseSubjectName, AbuseThresholdConfig>>;

let testOverrides: ThresholdOverride | null = null;

/** Read the effective config for one subject (production + test override). */
export function getAbuseThreshold(subject: AbuseSubjectName): AbuseThresholdConfig {
  if (testOverrides !== null && testOverrides[subject] !== undefined) {
    return testOverrides[subject]!;
  }
  return THRESHOLDS[subject];
}

/**
 * [TEST-ONLY] Install isolated threshold configuration for the duration of a
 * test scope. NEVER call from production code paths. Pass null to restore
 * the production (unconfigured/OPEN) policy.
 */
export function __setTestAbuseThresholds(overrides: ThresholdOverride | null): void {
  testOverrides = overrides;
}
