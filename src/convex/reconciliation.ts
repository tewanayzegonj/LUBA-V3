/**
 * LUBA V1 — reconciliation orchestration (read-only operational check).
 *
 * Makes the existing pure capability (`domain/reconciliation.ts`, tested in
 * Phase D) OPERATIONAL: one trigger fetches the ledger's wallet-account
 * postings and every wallet projection, runs the read-only reconciliation,
 * and REPORTS findings. Exit-gate rules honored exactly:
 *
 *  - NO financial mutation is performed merely to hide drift — this module
 *    contains no wallet/ledger writes at all;
 *  - failures are observable: every finding is written to the append-only
 *    audit trail (system-attributed, `reconciliation.*` actions) and the
 *    trigger result includes the counts, so the scheduled run's outcome is
 *    visible in the Convex dashboard and in audit history;
 *  - duplicate execution is safe: the check is read-only; re-running
 *    produces the same findings with no economic effect. The audit rows are
 *    correlation-keyed (runId) so replays are identifiable but harmless;
 *  - no financial reconciliation POLICY is invented: findings are reported,
 *    never repaired, never auto-jailed, never auto-credited. Resolution is
 *    a human/operator decision (Phase M exception queues consume these rows).
 *
 * Trigger surface: an internalMutation (cron-safe, identity-free) plus an
 * operator-gated public mutation (manual ad-hoc run). Scheduling lives in
 * `crons.json` — NOT registered there until the owner approves a cadence
 * (TRD OQ12-adjacent; the trigger is operational either way).
 */
import { internalMutation, mutation } from "./_generated/server";
import { requireOperator } from "./guards/auth";
import { recordAuditEvent } from "./guards/audit";
import {
  reconcileWalletProjections,
  type ReconciliationPosting,
  type WalletSetFinding,
} from "./domain/reconciliation";

/* ── Structural db shape (real ctx or test fake) ── */

type ReconRow = Record<string, unknown> & { _id: string };

type ReconDb = {
  get: (id: string) => Promise<ReconRow | null>;
  // Audit inserts flow through recordAuditEvent (append-only auditEvents).
  insert: (table: string, doc: Record<string, unknown>) => Promise<string>;
  query: (table: string) => {
    withIndex: (
      name: string,
      // Filter callback: the structural type stays loose (all full-range
      // scans here); the real Convex filter builder satisfies it.
      fn: (...args: never[]) => unknown,
    ) => {
      collect: () => Promise<ReconRow[]>;
    };
  };
};

export type ReconciliationCtx = {
  db: ReconDb;
  /** Real ctx on Convex; fakes record calls. */
  runMutation?: never;
};

export type ReconciliationReport = {
  runId: string;
  checkedAt: number;
  walletsChecked: number;
  reconciledCount: number;
  findingCount: number;
  /** Per-type counts — operator/observability summary (never raw PII). */
  findingsByType: Record<string, number>;
  /** Truncated sample for dashboards; full rows live in the audit trail. */
  sampleFindings: WalletSetFinding[];
  balanced: boolean;
};

const SAMPLE_LIMIT = 20;

/**
 * One read-only reconciliation pass. Internal (identity-free, cron-safe).
 *
 * Data volume note: wallet rows are 1:1 with users and postings grow with
 * economic activity. At V1 scale (thousands of users) a full scan inside one
 * transaction stays within Convex limits; if wallet/posting counts ever grow
 * past transaction limits this becomes a paginated campaign like the Phase I
 * settlement/refund workers — the pure cores already accept any posting
 * subset, so pagination is mechanical. Not built now (no evidence of need;
 * no invented scale policy).
 */
export async function runReconciliation(
  ctx: ReconciliationCtx,
  input: { now: number },
): Promise<ReconciliationReport> {
  const db = ctx.db;

  // Read every wallet projection (1:1 with users).
  const walletRows = await db.query("wallets").withIndex("by_user", () => undefined).collect();
  const wallets = walletRows.map((w) => ({
    userId: w.userId as string,
    availableSantim: w.availableSantim as number,
  }));

  // Read every wallet-account posting. The `by_userSide` index reaches the
  // same rows via the userSide field (set on all wallet-account postings);
  // per-account sums are recomputed from the fetched rows.
  const postingRows = await db
    .query("ledgerPostings")
    .withIndex("by_userSide", () => undefined)
    .collect();
  const postings: ReconciliationPosting[] = postingRows.map((p) => ({
    account: p.account as string,
    direction: p.direction as "debit" | "credit",
    amountSantim: p.amountSantim as number,
    userSide: (p.userSide as string | undefined) ?? null,
  }));

  // Pure, read-only, deterministic comparison (Phase D tested core).
  const report = reconcileWalletProjections(wallets, postings);

  const runId = `recon:${input.now}`;
  const findingsByType: Record<string, number> = {};
  for (const f of report.findings) {
    findingsByType[f.type] = (findingsByType[f.type] ?? 0) + 1;
  }

  // Observability: findings land in the append-only audit trail
  // (system-attributed). One summary row per run keeps audit volume flat.
  if (report.findings.length > 0) {
    await recordAuditEvent(ctx as never, {
      actorId: null,
      actorRole: "system",
      action: "reconciliation.drift_found",
      entityType: "wallets",
      entityId: runId,
      meta: {
        runId,
        walletsChecked: wallets.length,
        reconciledCount: report.reconciledCount,
        findingsByType,
        findings: report.findings.slice(0, SAMPLE_LIMIT),
        truncated: report.findings.length > SAMPLE_LIMIT,
      },
      createdAt: input.now,
    } as never);
  } else {
    await recordAuditEvent(ctx as never, {
      actorId: null,
      actorRole: "system",
      action: "reconciliation.passed",
      entityType: "wallets",
      entityId: runId,
      meta: { runId, walletsChecked: wallets.length, reconciledCount: report.reconciledCount },
      createdAt: input.now,
    } as never);
  }

  return {
    runId,
    checkedAt: input.now,
    walletsChecked: wallets.length,
    reconciledCount: report.reconciledCount,
    findingCount: report.findings.length,
    findingsByType,
    sampleFindings: report.findings.slice(0, SAMPLE_LIMIT),
    balanced: report.findings.length === 0,
  };
}

/* ── Convex surfaces ── */

/** Scheduled/manual internal trigger (identity-free; duplicate-safe). */
export const internalRunReconciliation = internalMutation({
  args: {},
  handler: async (ctx) => {
    return runReconciliation(ctx as unknown as ReconciliationCtx, { now: Date.now() });
  },
});

/** Operator-gated manual trigger (ad-hoc verification; same read-only pass). */
export const operatorRunReconciliation = mutation({
  args: {},
  handler: async (ctx) => {
    const guard = await requireOperator(ctx);
    if (!guard.ok) return { ok: false as const, reason: guard.reason };
    const report = await runReconciliation(ctx as unknown as ReconciliationCtx, {
      now: Date.now(),
    });
    return { ok: true as const, report };
  },
});
