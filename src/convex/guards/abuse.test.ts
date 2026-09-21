import { describe, expect, test } from "bun:test";

import {
  evaluateRateLimit,
  nextCount,
  windowStartFor,
  type AbuseSubjectName,
} from "../domain/abuse";
import { __setTestAbuseThresholds } from "../abuseConfig";
import { checkAndRecordRate, type AbuseGuardCtx } from "./abuse";

/* ── Counter store fake (rows live outside ctx — structural typing) ── */

type Row = Record<string, unknown> & { _id: string };

function makeAbuseCtx(): { ctx: AbuseGuardCtx; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;
  const ctx: AbuseGuardCtx = {
    db: {
      get: async (id: string) => rows.find((r) => r._id === id) ?? null,
      insert: async (table: string, doc: Record<string, unknown>) => {
        const id = `abuseCounters:${++seq}`;
        rows.push({ _id: id, ...doc });
        return id;
      },
      patch: async (id: string, doc: Record<string, unknown>) => {
        const row = rows.find((r) => r._id === id);
        if (!row) throw new Error(`patch on missing row ${id}`);
        Object.assign(row, doc);
      },
      query: () => ({
        withIndex: (_name: string, fn: (q: never) => unknown) => {
          const filters: Array<[string, unknown]> = [];
          // The real Convex filter builder chains .eq(); capture all fields.
          type EqBuilder = { eq: (field: string, value: unknown) => EqBuilder };
          const make = (): EqBuilder => ({
            eq: (field: string, value: unknown) => {
              filters.push([field, value]);
              return make();
            },
          });
          void fn(make() as never);
          const matched = rows.filter((r) => filters.every(([f, v]) => r[f] === v));
          return {
            unique: async () => (matched.length > 0 ? matched[0] : null),
          };
        },
      }),
    },
  };
  return { ctx, rows };
}

describe("abuse guard (mechanism only; thresholds stay OPEN in production)", () => {
  test("inactive guard (threshold OPEN): zero writes, caller behavior unchanged", async () => {
    __setTestAbuseThresholds(null); // production policy: every threshold null
    try {
      const { ctx, rows } = makeAbuseCtx();
      for (let i = 0; i < 50; i++) {
        const res = await checkAndRecordRate(ctx, {
          subject: "bid_submit",
          subjectId: "users:u1",
          now: 1_000_000,
        });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.guardActive).toBe(false);
      }
      expect(rows).toHaveLength(0); // zero-effect no-op
    } finally {
      __setTestAbuseThresholds(null); // always restore the production policy
    }
  });

  test("active guard: first hit creates the counter, later hits increment one row", async () => {
    __setTestAbuseThresholds({ otp_request: { threshold: 5, windowMs: 60_000 } });
    try {
      const { ctx, rows } = makeAbuseCtx();
      for (let i = 0; i < 5; i++) {
        const res = await checkAndRecordRate(ctx, {
          subject: "otp_request",
          subjectId: "+251911000000",
          now: 1_000_000,
        });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.guardActive).toBe(true);
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(5);
    } finally {
      __setTestAbuseThresholds(null);
    }
  });

  test("window full: refusal carries rate_limited + retryAfterMs; refused hits consume no slot", async () => {
    __setTestAbuseThresholds({ bid_submit: { threshold: 3, windowMs: 60_000 } });
    try {
      const { ctx, rows } = makeAbuseCtx();
      const w0 = 60_000; // window-aligned start: [60_000, 120_000)
      for (let i = 0; i < 3; i++) {
        const res = await checkAndRecordRate(ctx, {
          subject: "bid_submit",
          subjectId: "users:u2",
          now: w0,
        });
        expect(res.ok).toBe(true);
      }
      const refused = await checkAndRecordRate(ctx, {
        subject: "bid_submit",
        subjectId: "users:u2",
        now: w0 + 30_000,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toBe("rate_limited");
        expect(refused.retryAfterMs).toBe(30_000); // windowStart + windowMs − now
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(3); // refusal did not bump the counter
    } finally {
      __setTestAbuseThresholds(null);
    }
  });

  test("fixed window: next window starts fresh (no cross-window state)", async () => {
    __setTestAbuseThresholds({ otp_verify: { threshold: 2, windowMs: 60_000 } });
    try {
      const { ctx, rows } = makeAbuseCtx();
      const w0 = 60_000; // window [60_000, 120_000)
      const w1 = w0 + 60_000; // next window boundary
      await checkAndRecordRate(ctx, { subject: "otp_verify", subjectId: "users:u3", now: w0 });
      await checkAndRecordRate(ctx, { subject: "otp_verify", subjectId: "users:u3", now: w0 + 59_999 });
      const refused = await checkAndRecordRate(ctx, { subject: "otp_verify", subjectId: "users:u3", now: w0 + 59_999 });
      expect(refused.ok).toBe(false);

      const fresh = await checkAndRecordRate(ctx, { subject: "otp_verify", subjectId: "users:u3", now: w1 });
      expect(fresh.ok).toBe(true);
      expect(rows).toHaveLength(2); // one counter row per window
      const w1Row = rows.find((r) => r.windowStart === windowStartFor(w1, 60_000));
      expect(w1Row?.count).toBe(1);
    } finally {
      __setTestAbuseThresholds(null);
    }
  });

  test("subject isolation: counters are per (subject, subjectId)", async () => {
    __setTestAbuseThresholds({
      deposit_init: { threshold: 1, windowMs: 60_000 },
      withdrawal_req: { threshold: 1, windowMs: 60_000 },
    });
    try {
      const { ctx, rows } = makeAbuseCtx();
      const a = await checkAndRecordRate(ctx, { subject: "deposit_init", subjectId: "users:uA", now: 60_000 });
      const b = await checkAndRecordRate(ctx, { subject: "deposit_init", subjectId: "users:uB", now: 60_000 });
      const c = await checkAndRecordRate(ctx, { subject: "withdrawal_req", subjectId: "users:uA", now: 60_000 });
      expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
      const refused = await checkAndRecordRate(ctx, { subject: "deposit_init", subjectId: "users:uA", now: 60_000 });
      expect(refused.ok).toBe(false);
      expect(rows).toHaveLength(3); // one row per (subject, subjectId) pair
    } finally {
      __setTestAbuseThresholds(null);
    }
  });

  test("every AbuseSubjectName is covered by the mechanism (future seams included)", async () => {
    __setTestAbuseThresholds({ withdrawal_req: { threshold: 1, windowMs: 60_000 } });
    try {
      const subjects: AbuseSubjectName[] = [
        "otp_request",
        "otp_verify",
        "bid_submit",
        "deposit_init",
        "withdrawal_req",
      ];
      for (const subject of subjects) {
        const { ctx } = makeAbuseCtx();
        const res = await checkAndRecordRate(ctx, { subject, subjectId: "users:x", now: 1_000_000 });
        expect(res.ok).toBe(true);
      }
    } finally {
      __setTestAbuseThresholds(null);
    }
  });

  test("domain cores: boundary semantics, nextCount, windowStartFor", () => {
    expect(windowStartFor(95_000, 60_000)).toBe(60_000);
    expect(windowStartFor(60_000, 60_000)).toBe(60_000);
    expect(windowStartFor(119_999, 60_000)).toBe(60_000);
    expect(nextCount(null)).toBe(1);
    expect(nextCount({ count: 7 } as never)).toBe(8);
    const full = evaluateRateLimit({ threshold: 2, windowMs: 60_000, now: 90_000, existingCount: 2 });
    expect(full.allowed).toBe(false);
    const fresh = evaluateRateLimit({ threshold: 2, windowMs: 60_000, now: 90_000, existingCount: null });
    expect(fresh.allowed).toBe(true);
    expect(fresh.observedCount).not.toBeNull();
  });
});
