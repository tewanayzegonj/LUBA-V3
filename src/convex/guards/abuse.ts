/**
 * LUBA V1 — abuse-counter guard (ctx adapter over the pure decision cores).
 *
 * Composes `domain/abuse.ts` decisions with real `abuseCounters` reads and
 * writes. Generic throttling ONLY — Backend Schema §16 forbids using this
 * mechanism as a bid-volume cap; the frozen idempotency/concurrency behavior
 * of every entry point is untouched (the guard runs before business logic,
 * inside the caller's transaction, so OCC semantics are unchanged).
 *
 * Uniqueness note: `(subject, subjectId, windowStart)` uniqueness on the
 * `by_subject_window` index is enforced transactionally — the read/insert
 * race is resolved by Convex OCC (concurrent writers conflict on the same
 * index range and retry; the loser re-reads and increments the winner's row).
 * No double-count persists because both transactions serialize on the range.
 *
 * Identity-free safety: `subjectId` is caller-supplied (a user id or phone
 * hash). For unauthenticated subjects (otp_request/otp_verify before a user
 * row exists) it is the normalized phone hash — never raw PII. Internal
 * workers (identity-free by design) do not compose this guard on their own
 * scheduled paths; only user-initiated entry points do.
 */
import type { Id } from "../_generated/dataModel";

import { evaluateRateLimit, nextCount, windowStartFor } from "../domain/abuse";
import { getAbuseThreshold } from "../abuseConfig";

/** Structural shape of the caller's ctx (real MutationCtx or a test fake). */
export type AbuseGuardCtx = {
  db: {
    get: (id: string) => Promise<Record<string, unknown> | null>;
    insert: (table: string, doc: Record<string, unknown>) => Promise<string>;
    patch: (id: string, doc: Record<string, unknown>) => Promise<void>;
    query: (table: string) => {
      withIndex: (
        name: string,
        fn: (q: {
          eq: (field: string, value: unknown) => { eq: (field: string, value: unknown) => { eq: (field: string, value: unknown) => unknown } };
        }) => unknown,
      ) => { unique: () => Promise<Record<string, unknown> | null> };
    };
  };
};

export type AbuseGuardOk = { ok: true; windowStart: number; guardActive: boolean };
export type AbuseGuardRefusal = { ok: false; reason: "rate_limited"; windowStart: number; retryAfterMs: number };

/**
 * Check-and-record one hit for (subject, subjectId) in the current window.
 *
 * Behavior:
 *  - guard inactive (threshold OPEN/unset) ⇒ `{ ok: true, guardActive: false }`
 *    with ZERO writes — unconfigured subjects behave exactly as before;
 *  - guard active and window full ⇒ `{ ok: false, reason: "rate_limited" }`
 *    with the fixed retry delay (ms until the next window boundary);
 *  - guard active and allowed ⇒ counter row created or incremented IN the
 *    caller's transaction (atomic with the guarded effect).
 *
 * Throws on storage failure — aborts the surrounding transaction (fail safe:
 * a broken guard never waves callers through with a half-written counter).
 */
export async function checkAndRecordRate(
  ctx: AbuseGuardCtx,
  input: { subject: Parameters<typeof getAbuseThreshold>[0]; subjectId: string; now: number },
): Promise<AbuseGuardOk | AbuseGuardRefusal> {
  const config = getAbuseThreshold(input.subject);
  const windowStart = windowStartFor(input.now, config.windowMs);

  const existing = (await ctx.db
    .query("abuseCounters")
    .withIndex("by_subject_window", (q) =>
      q.eq("subject", input.subject).eq("subjectId", input.subjectId).eq("windowStart", windowStart),
    )
    .unique()) as { _id: string; count: number } | null;

  const decision = evaluateRateLimit({
    threshold: config.threshold,
    windowMs: config.windowMs,
    now: input.now,
    existingCount: existing !== null ? existing.count : null,
  });
  if (!decision.ok) throw new Error("abuse guard: unreachable decision failure");
}
