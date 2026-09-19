import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";

import { reconcileWalletProjections, type ReconciliationPosting } from "./reconciliation";
import { ensureWallet, postWalletTransaction, auditWalletRows } from "../financial/wallet";

/* ── Test doubles ── */

const USER = "users:u1" as Id<"users">;
const OTHER = "users:u2" as Id<"users">;

/**
 * In-memory db fake satisfying the structural shapes of the wallet and
 * ledger modules (insert/get/patch/query). No update/delete of journal
 * tables exists — mirroring the append-only truth; `patch` is wallets-only
 * in production. `failOnPatch` simulates an OCC conflict mid-transaction.
 */
function makeWalletDb(options: { failOnInsertOf?: string; failOnPatch?: boolean } = {}) {
  const rows: Record<string, Array<Record<string, unknown> & { _id: string }>> = {
    wallets: [],
    ledgerEntries: [],
    ledgerPostings: [],
    idempotencyRecords: [],
    auditEvents: [],
  };
  let seq = 0;
  const patchCalls: Array<{ id: string; doc: Record<string, unknown> }> = [];

  const db = {
    async insert(table: string, doc: Record<string, unknown>) {
      if (options.failOnInsertOf === table) throw new Error(`simulated ${table} failure`);
      seq += 1;
      const row: Record<string, unknown> & { _id: string } = { _id: `${table}:${seq}`, ...doc };
      rows[table]?.push(row);
      return row._id;
    },
    async get(id: string) {
      for (const list of Object.values(rows)) {
        const found = list.find((r) => r._id === id);
        if (found) return found;
      }
      return null;
    },
    async patch(id: string, doc: Record<string, unknown>) {
      if (options.failOnPatch) throw new Error("simulated wallet patch failure (OCC abort)");
      patchCalls.push({ id, doc });
      for (const list of Object.values(rows)) {
        const row = list.find((r) => r._id === id);
        if (row) Object.assign(row, doc);
      }
    },
    query(table: string) {
      const list = rows[table] ?? [];
      return {
        withIndex(
          _name: string,
          fn: (q: { eq: (field: string, value: string) => unknown }) => unknown,
        ) {
          let capturedField = "";
          let capturedValue: unknown;
          fn({
            eq: (field: string, value: string) => {
              capturedField = field;
              capturedValue = value;
              return capturedValue;
            },
          });
          return {
            async unique() {
              return list.find((r) => r[capturedField] === capturedValue) ?? null;
            },
            async collect() {
              return list.filter((r) => r[capturedField] === capturedValue);
            },
          };
        },
      };
    },
  };
  return { db, rows, patchCalls };
}

/** Seed an existing wallet row directly (bypassing ensureWallet). */
async function seedWallet(
  store: ReturnType<typeof makeWalletDb>,
  userId: Id<"users">,
  availableSantim: number,
) {
  const id = await store.db.insert("wallets", {
    userId,
    availableSantim,
    updatedAt: 0,
  });
  return id;
}

function walletDeposit(userId: Id<"users">, amount: number, token: string) {
  return {
    kind: "deposit" as const,
    refType: "paymentEvent" as const,
    refId: "paymentEvents:p1",
    walletLegs: [{ userId, deltaSantim: amount }],
    counterpartPostings: [
      { account: "platform:deposit_clearing", direction: "debit" as const, amountSantim: amount },
    ],
    ownerUserId: userId as Id<"users"> | null,
    idempotencyToken: token,
    idempotencyOp: "deposit_confirm" as const,
  };
}

function walletFeeDebit(userId: Id<"users">, amount: number, token: string) {
  return {
    kind: "bid_fee" as const,
    refType: "bid" as const,
    refId: "bids:b1",
    walletLegs: [{ userId, deltaSantim: -amount }],
    counterpartPostings: [
      { account: "platform:bid_fee_revenue", direction: "credit" as const, amountSantim: amount },
    ],
    ownerUserId: userId as Id<"users"> | null,
    idempotencyToken: token,
    idempotencyOp: "bid" as const,
  };
}

function walletBalanceOf(store: ReturnType<typeof makeWalletDb>, userId: Id<"users">): number {
  const wallet = store.rows.wallets.find((w) => w.userId === userId);
  return wallet ? (wallet.availableSantim as number) : NaN;
}

/* ── ensureWallet ── */

describe("ensureWallet — 1:1 projection provisioning", () => {
  test("creates the wallet at zero with required metadata", async () => {
    const store = makeWalletDb();
    const result = await ensureWallet(store, USER);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.created) throw new Error("expected created");
    expect(result.availableSantim).toBe(0);

    const row = store.rows.wallets[0];
    expect(row.userId).toBe(USER);
    expect(row.availableSantim).toBe(0);
    expect(typeof row.updatedAt).toBe("number");
  });

  test("second call returns the SAME wallet (one wallet per user)", async () => {
    const store = makeWalletDb();
    const first = await ensureWallet(store, USER);
    const second = await ensureWallet(store, USER);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.created).toBe(false);
      expect(second.walletId).toBe(first.walletId);
    }
    expect(store.rows.wallets.length).toBe(1);
  });

  test("duplicate wallet rows are an invariant failure (never silently reused)", async () => {
    const store = makeWalletDb();
    await seedWallet(store, USER, 0);
    await seedWallet(store, USER, 0);
    const result = await ensureWallet(store, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("duplicate_wallets");
  });

  test("structurally invalid stored balance is reported, not propagated", async () => {
    const store = makeWalletDb();
    await store.db.insert("wallets", { userId: USER, availableSantim: -5, updatedAt: 0 });
    const result = await ensureWallet(store, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_wallet");
  });
});

/* ── postWalletTransaction — the atomic economic primitive ── */

describe("postWalletTransaction", () => {
  test("positive credit projects the new balance and posts a balanced entry", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);

    const result = await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "posted") throw new Error("expected posted");
    expect(result.balances).toEqual([{ userId: USER, availableSantim: 100_00 }]);

    expect(store.rows.ledgerEntries.length).toBe(1);
    expect(store.rows.ledgerPostings.length).toBe(2);
    expect(walletBalanceOf(store, USER)).toBe(100_00);
  });

  test("valid debit projects the decrease (balance remains non-negative)", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));

    const result = await postWalletTransaction(store, walletFeeDebit(USER, 5_00, "tok-d1"));
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "posted") throw new Error("expected posted");
    expect(result.balances).toEqual([{ userId: USER, availableSantim: 95_00 }]);
    expect(walletBalanceOf(store, USER)).toBe(95_00);

    // Both journal entries are still balanced and appended.
    expect(store.rows.ledgerEntries.length).toBe(2);
    expect(store.rows.ledgerPostings.length).toBe(4);
  });

  test("insufficient balance is rejected with ZERO economic effect", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await postWalletTransaction(store, walletDeposit(USER, 3_00, "tok-c1"));

    const result = await postWalletTransaction(store, walletFeeDebit(USER, 10_00, "tok-d1"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_funds");

    expect(walletBalanceOf(store, USER)).toBe(3_00);
    expect(store.rows.ledgerEntries.length).toBe(1); // only the deposit
    expect(store.rows.ledgerPostings.length).toBe(2);
    expect(store.rows.idempotencyRecords.length).toBe(1);
  });

  test("zero and non-integer deltas are rejected before any write", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);

    for (const delta of [0, 1.5, -0]) {
      const result = await postWalletTransaction(store, {
        ...walletDeposit(USER, 1_00, "tok-x"),
        walletLegs: [{ userId: USER, deltaSantim: delta }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_wallet_leg");
    }
    expect(store.rows.ledgerEntries.length).toBe(0);
    expect(store.patchCalls.length).toBe(0);
  });

  test("missing wallet projection is a clean rejection (no ledger orphan)", async () => {
    const store = makeWalletDb();
    const result = await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wallet_not_found");
    expect(store.rows.ledgerEntries.length).toBe(0);
  });

  test("atomic: failure propagates with no wallet patch and no cleanup writes", async () => {
    const store = makeWalletDb({ failOnPatch: true });
    await ensureWallet(store, USER);

    let threw = false;
    try {
      await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("simulated wallet patch failure");
    }
    expect(threw).toBe(true);
    // The primitive performs zero wallet patches when anything fails and
    // never compensates with cleanup writes; in production the surrounding
    // Convex transaction aborts (OCC), rolling back the journal append too —
    // a wallet can never move without its balanced journal entry.
    expect(store.patchCalls.length).toBe(0);
  });

  test("replay returns the original outcome with zero projection mutation", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    const first = await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));
    expect(first.ok).toBe(true);

    const replay = await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));
    expect(replay.ok).toBe(true);
    if (!replay.ok || replay.status !== "replay") throw new Error("expected replay");
    if (!first.ok || first.status !== "posted") throw new Error("expected first posted");
    expect(replay.outcome).toBe(first.outcome);
    expect(replay.balances).toBeNull();
    expect(walletBalanceOf(store, USER)).toBe(100_00); // unchanged
    expect(store.rows.ledgerEntries.length).toBe(1);
  });

  test("changed request with the same key is a conflict — wallet untouched", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));

    const conflict = await postWalletTransaction(store, walletDeposit(USER, 50_00, "tok-c1"));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("idempotency_conflict");
    expect(walletBalanceOf(store, USER)).toBe(100_00);
    expect(store.rows.ledgerEntries.length).toBe(1);
  });

  test("OCC safety: per-user availability is checked in the same transaction", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await postWalletTransaction(store, walletDeposit(USER, 5_00, "tok-c1"));

    // Two logical debits racing the same balance: in Convex both mutations
    // read the projection at transaction start; the second commit conflicts
    // on the patched row and retries, re-evaluating availability against the
    // NEW balance — one of these legitimately fails with insufficient funds.
    const first = await postWalletTransaction(store, walletFeeDebit(USER, 4_00, "tok-d1"));
    expect(first.ok).toBe(true);
    const second = await postWalletTransaction(store, walletFeeDebit(USER, 4_00, "tok-d2"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("insufficient_funds");
    expect(walletBalanceOf(store, USER)).toBe(1_00);
  });
});

/* ── Reconciliation: projection vs ledger ── */

describe("wallet reconciliation", () => {
  function toReconciliationPostings(
    store: ReturnType<typeof makeWalletDb>,
  ): ReconciliationPosting[] {
    return store.rows.ledgerPostings.map((posting) => ({
      account: posting.account as string,
      direction: posting.direction as "debit" | "credit",
      amountSantim: posting.amountSantim as number,
      userSide: (posting.userSide as string | undefined) ?? null,
    }));
  }

  test("projection agrees with ledger after credit and debit", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await ensureWallet(store, OTHER);
    await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));
    await postWalletTransaction(store, walletDeposit(OTHER, 50_00, "tok-c2"));
    await postWalletTransaction(store, walletFeeDebit(USER, 5_00, "tok-d1"));

    const result = reconcileWalletProjections(
      [
        { userId: USER, availableSantim: walletBalanceOf(store, USER) },
        { userId: OTHER, availableSantim: walletBalanceOf(store, OTHER) },
      ],
      toReconciliationPostings(store),
    );
    expect(result.findings).toEqual([]);
    expect(result.reconciledCount).toBe(2);
  });

  test("projection drift is detected as balance_divergence (never auto-repaired)", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));

    // Simulate drift by tampering with the projection directly (as a bug
    // would): the reconciliation REPORTS it; nothing repairs it here.
    const row = store.rows.wallets[0];
    row.availableSantim = 90_00;

    const result = reconcileWalletProjections(
      [{ userId: USER, availableSantim: 90_00 }],
      toReconciliationPostings(store),
    );
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.type).toBe("balance_divergence");
    if (result.findings[0]?.type === "balance_divergence") {
      expect(result.findings[0].differenceSantim).toBe(-10_00);
    }
  });

  test("missing wallet: ledger activity without a projection row is found", async () => {
    const store = makeWalletDb();
    await ensureWallet(store, USER);
    await postWalletTransaction(store, walletDeposit(USER, 100_00, "tok-c1"));

    // OTHER has no projection row yet — but simulate ledger activity by
    // crediting their wallet account with a direct counterpart-free pair:
    const orphan = await postWalletTransaction(store, {
      kind: "deposit",
      refType: "paymentEvent",
      refId: "paymentEvents:p2",
      walletLegs: [{ userId: OTHER, deltaSantim: 25_00 }],
      counterpartPostings: [
        { account: "platform:deposit_clearing", direction: "debit", amountSantim: 25_00 },
      ],
      ownerUserId: OTHER,
      idempotencyToken: "tok-c3",
      idempotencyOp: "deposit_confirm",
    });
    // OTHER's wallet doesn't exist — the primitive must have refused.
    expect(orphan.ok).toBe(false);

    // Force the missing-wallet scenario at the reconciliation layer only:
    // postings exist for OTHER while the projection set omits them.
    const postings = toReconciliationPostings(store);
    postings.push({
      account: `wallet:${OTHER}`,
      direction: "credit",
      amountSantim: 25_00,
      userSide: OTHER,
    });
    const result = reconcileWalletProjections(
      [{ userId: USER, availableSantim: walletBalanceOf(store, USER) }],
      postings,
    );
    const missing = result.findings.find((f) => f.type === "missing_wallet");
    expect(missing).toBeDefined();
    if (missing?.type === "missing_wallet") {
      expect(missing.account).toBe(`wallet:${OTHER}`);
      expect(missing.ledgerBalanceSantim).toBe(25_00);
    }
  });

  test("negative available balance on a projection row is reported", () => {
    const result = reconcileWalletProjections(
      [{ userId: USER, availableSantim: -1 }],
      [],
    );
    expect(result.findings.some((f) => f.type === "negative_balance")).toBe(true);
  });

  test("wallet row structural audit flags negative and non-integer balances", () => {
    const findings = auditWalletRows([
      { _id: "wallets:1" as Id<"wallets">, userId: USER, availableSantim: -5 },
      { _id: "wallets:2" as Id<"wallets">, userId: OTHER, availableSantim: 10.5 },
      { _id: "wallets:3" as Id<"wallets">, userId: USER, availableSantim: 0 },
    ]);
    expect(findings.length).toBe(2);
    expect(findings[0]?.type).toBe("negative_balance");
    expect(findings[1]?.type).toBe("invalid_balance");
  });
});
