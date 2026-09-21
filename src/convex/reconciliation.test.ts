/**
 * Phase I exit-gate — reconciliation trigger tests (Task 3).
 *
 * The trigger (`runReconciliation`) is read-only, observable, and
 * duplicate-safe: it performs NO financial mutation on drift (findings are
 * only reported to the audit trail), and every run recomputes from the
 * ledger + wallet rows, so duplicate execution cannot compound anything.
 */
import { describe, expect, test } from "bun:test";

import { runReconciliation, type ReconciliationCtx } from "./reconciliation";

/* ── Read-only store fake matching the trigger's structural db shape ── */

type Row = Record<string, unknown> & { _id: string };

function makeCtx(initial: Row[] = []): { ctx: ReconciliationCtx; rows: Row[] } {
  const rows = [...initial];
  let seq = 10_000;
  const ctx: ReconciliationCtx = {
    db: {
      get: async (id: string) => rows.find((r) => r._id === id) ?? null,
      insert: async (table: string, doc: Record<string, unknown>) => {
        const id = `${table}:${++seq}`;
        rows.push({ _id: id, ...doc });
        return id;
      },
      query: (table: string) => ({
        withIndex: (_name: string, fn: (...args: never[]) => unknown) => {
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
          // Only rows of the queried table participate (ids are `<table>:N`).
          const matched = rows.filter(
            (r) => (r._id as string).startsWith(`${table}:`) && filters.every(([f, v]) => r[f] === v),
          );
          return {
            collect: async () => matched,
          };
        },
      }),
    },
  };
  return { ctx, rows };
}

/* ── Row factories (mirror schema validators) ── */

let seq = 0;
const nid = (prefix: string) => `${prefix}:${++seq}`;

function walletRow(userId: string, availableSantim: number): Row {
  return { _id: nid("wallets"), userId, availableSantim, updatedAt: 1 };
}

/** Wallet-account posting. Credits are money IN (user perspective). */
function walletPosting(userId: string, direction: "debit" | "credit", amountSantim: number): Row {
  return {
    _id: nid("ledgerPostings"),
    account: `wallet:${userId}`,
    direction,
    amountSantim,
    userSide: userId,
    refId: nid("ref"),
    refType: "deposit",
    kind: "deposit",
    createdAt: 1,
  };
}

const ALICE = "users:alice";

describe("reconciliation trigger (operational; read-only; duplicate-safe)", () => {
  test("balanced wallet ⇒ healthy report; exactly one audit row; no financial writes", async () => {
    const w = walletRow(ALICE, 5_000);
    // Wallet is a liability: deposit = CREDIT of the wallet account.
    const postings = [walletPosting(ALICE, "credit", 5_000)];
    const { ctx, rows } = makeCtx([w, ...postings]);

    const report = await runReconciliation(ctx, { now: 1_234_567_890 });
    expect(report.balanced).toBe(true);
    expect(report.findingCount).toBe(0);
    expect(report.walletsChecked).toBe(1);
    expect(report.reconciledCount).toBe(1);

    const auditRows = rows.filter((r) => (r._id as string).startsWith("auditEvents:"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("reconciliation.passed");
    expect(auditRows[0].actorRole).toBe("system");
  });

  test("drift (wallet ≠ ledger truth) is detected and reported — NOT auto-corrected", async () => {
    // Ledger says 5,000 (credit); wallet projection shows 4,999.
    const w = walletRow(ALICE, 4_999);
    const postings = [walletPosting(ALICE, "credit", 5_000)];
    const { ctx, rows } = makeCtx([w, ...postings]);

    const report = await runReconciliation(ctx, { now: 2_000_000_000 });
    expect(report.balanced).toBe(false);
    expect(report.findingCount).toBe(1);
    expect(report.sampleFindings[0]).toMatchObject({
      type: "balance_divergence",
      account: `wallet:${ALICE}`,
      ledgerBalanceSantim: 5_000,
      walletAvailableSantim: 4_999,
      differenceSantim: -1,
    });

    // NO financial mutation: the wallet row is untouched.
    const walletAfter = rows.find((r) => r._id === w._id)!;
    expect(walletAfter.availableSantim).toBe(4_999);
    // Observability: drift lands in the audit trail under its own action.
    const auditRows = rows.filter((r) => (r._id as string).startsWith("auditEvents:"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("reconciliation.drift_found");
  });

  test("wallet without postings ⇒ no_ledger_activity finding; zero-posting path is observable", async () => {
    const w = walletRow(ALICE, 0);
    const { ctx, rows } = makeCtx([w]);
    const report = await runReconciliation(ctx, { now: 3_000_000_000 });
    expect(report.balanced).toBe(false);
    expect(report.sampleFindings[0]?.type).toBe("no_ledger_activity");
    const auditRows = rows.filter((r) => (r._id as string).startsWith("auditEvents:"));
    expect(auditRows).toHaveLength(1);
  });

  test("missing projection row (postings but no wallet) is detected", async () => {
    const postings = [walletPosting("users:ghost", "credit", 1_234)];
    const { ctx } = makeCtx([...postings]);
    const report = await runReconciliation(ctx, { now: 4_000_000_000 });
    expect(report.balanced).toBe(false);
    expect(report.sampleFindings[0]).toMatchObject({
      type: "missing_wallet",
      account: "wallet:users:ghost",
      ledgerBalanceSantim: 1_234,
    });
  });

  test("duplicate execution is safe: identical reports, no compounding effects", async () => {
    const w = walletRow(ALICE, 5_000);
    const postings = [walletPosting(ALICE, "credit", 5_000)];
    const { ctx, rows } = makeCtx([w, ...postings]);

    const r1 = await runReconciliation(ctx, { now: 5_000_000_000 });
    const r2 = await runReconciliation(ctx, { now: 5_000_000_100 });
    // Same economic truth ⇒ same findings; only the correlation key and
    // timestamp differ per run (both are observability metadata, not state).
    const economic = (r: Awaited<ReturnType<typeof runReconciliation>>) => ({
      balanced: r.balanced,
      findingCount: r.findingCount,
      findingsByType: r.findingsByType,
      sampleFindings: r.sampleFindings,
      walletsChecked: r.walletsChecked,
      reconciledCount: r.reconciledCount,
    });
    expect(economic(r2)).toEqual(economic(r1));
    expect(r1.balanced).toBe(true);
    expect(r2.balanced).toBe(true);

    // No financial rows were created or mutated by either run.
    expect(rows.filter((r) => (r._id as string).startsWith("wallets:"))).toHaveLength(1);
    expect(rows.filter((r) => (r._id as string).startsWith("ledgerPostings:"))).toHaveLength(1);
  });

  test("empty system ⇒ healthy with zero wallets; still observable", async () => {
    const { ctx, rows } = makeCtx([]);
    const report = await runReconciliation(ctx, { now: 6_000_000_000 });
    expect(report.balanced).toBe(true);
    expect(report.walletsChecked).toBe(0);
    const auditRows = rows.filter((r) => (r._id as string).startsWith("auditEvents:"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("reconciliation.passed");
  });
});
