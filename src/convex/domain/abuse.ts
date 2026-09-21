/**
 * LUBA V1 — pure anti-abuse decision cores (generic throttling ONLY).
 *
 * Backend Schema §16: `abuseCounters` exists for generic anti-abuse
 * throttling and is explicitly NEVER a bid-count cap. This module holds the
 * deterministic decision logic consumed by the ctx adapter in
 * `guards/abuse.ts`; no ctx, no db, no I/O.
 *
 * Threshold policy: every threshold lives in `src/convex/abuseConfig.ts` and
 * is NULL while the value is OPEN (TRD OQ11). A null threshold means the
 * guard is INACTIVE for that subject — the mechanism carries the seam, never
 * a default value (Implementation Plan §1.8: OPEN ≠ configured). No default
 * limit is invented anywhere in this file.
 *
 * Fail-safe semantics (exit-gate task spec): the guard evaluates BEFORE the
 * guarded operation runs; an internal failure throws, which aborts the
 * surrounding transaction — it never silently waves a caller through with a
 * half-written counter. When the subject's threshold is unconfigured the
 * guard is a zero-effect no-op, so current behavior is unchanged.
 *
 * Window model: fixed windows in UTC epoch millis (`windowStart = floor(now /
 * windowMs) * windowMs`). Counters are keyed (subject, subjectId,
 * windowStart) by the `by_subject_window` index — one row per subject per
 * window; the window rolls over by inserting the next row, so no history is
 * rewritten.
 */

/* ── Window arithmetic (pure) ── */

/** Fixed-window start for a decision time. Floors to the window boundary. */
export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/* ── Core decision ── */

export type AbuseSubjectName =
  | "otp_request"
  | "otp_verify"
  | "bid_submit"
  | "deposit_init"
  | "withdrawal_req";

export type RateLimitDecision =
  | { ok: true; allowed: true; windowStart: number; observedCount: number }
  | { ok: true; allowed: false; windowStart: number; observedCount: number }
  | { ok: true; allowed: true; windowStart: number; observedCount: null; reason: "guard_inactive" };

/**
 * Decide whether one more hit inside the current window is allowed.
 *
 * Inputs are server-fetched truth:
 *  - `threshold` / `windowMs` from configuration (threshold null ⇒ guard
 *    inactive ⇒ always allowed, zero policy invented);
 *  - `existingCount` — the stored count for (subject, subjectId, window),
 *    or null when no counter row exists yet for this window.
 *
 * Pure: callers perform the actual counter read/write (guards/abuse.ts).
 */
export function evaluateRateLimit(input: {
  threshold: number | null;
  windowMs: number;
  now: number;
  existingCount: number | null;
}): RateLimitDecision {
  if (input.threshold === null) {
    return {
      ok: true,
      allowed: true,
      windowStart: windowStartFor(input.now, input.windowMs),
      observedCount: null,
      reason: "guard_inactive",
    };
  }
  const windowStart = windowStartFor(input.now, input.windowMs);
  const observedCount = input.existingCount ?? 0;
  // Strictly greater: a counter AT the threshold means the window is full
  // (threshold = max hits allowed per window, counting the first hit).
  const allowed = observedCount + 1 <= input.threshold;
  return { ok: true, allowed, windowStart, observedCount };
}

/* ── Counter row shape (as stored) ── */

export type AbuseCounterRow = {
  subject: AbuseSubjectName;
  subjectId: string;
  windowStart: number;
  count: number;
};

/** The next count for a window given the stored row (or none). Pure. */
export function nextCount(existing: AbuseCounterRow | null): number {
  return (existing?.count ?? 0) + 1;
}
