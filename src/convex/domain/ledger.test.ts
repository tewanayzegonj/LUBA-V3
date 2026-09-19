import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";

import {
  evaluateLedgerEntry,
  type LedgerEntryDraft,
} from "./ledger";
import {
  accountBalance,
  accountBalances,
  transactionBalance,
  walletReconciliation,
} from "./reconciliation";
import { postLedgerTransaction } from "../financial/ledger";

/* ── Test doubles ── */

const USER = "users:u1" as Id<"users">;
const LOT_1 = "provenanceLots:l1" as Id<"provenanceLots">;
const LOT_2 = "provenanceLots:l2" as Id<"provenanceLots">;

/** Two-legged balanced draft: debit platform, credit user wallet. */
function balancedDraft(overrides: Partial<LedgerEntryDraft> = {}): LedgerEntryDraft {
  return {
    kind: "deposit",
    refType: "paymentEvent",
    refId: "paymentEvents:p1",
    postings: [
      { account: "platform:deposit_clearing", direction: "debit", amountSantim: 100_00 },
      { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 100_00 },
    ],
    ...overrides,
  };
}

describe("evaluateLedgerEntry — balance invariant", () => {
  test("balanced transaction is accepted", () => {
    const result = evaluateLedgerEntry(balancedDraft());
    expect(result.ok).toBe(true);
  });

  test("unbalanced entry is rejected atomically-pure (no side effects exist)", () => {
    const result = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          { account: "platform:deposit_clearing", direction: "debit", amountSantim: 100_00 },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 99_00 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unbalanced_entry");
  });

  test("multi-legged entries balance across more than two postings", () => {
    const result = evaluateLedgerEntry(
      balancedDraft({
        kind: "refund",
        refType: "bid",
        postings: [
          { account: "platform:bid_fee_revenue", direction: "debit", amountSantim: 3_00 },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 2_00, provenanceLotIds: [LOT_1] },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 1_00, provenanceLotIds: [LOT_2] },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("fewer than two postings is structurally invalid", () => {
    const one = evaluateLedgerEntry(
      balancedDraft({
        postings: [{ account: "platform:deposit_clearing", direction: "debit", amountSantim: 100_00 }],
      }),
    );
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.reason).toBe("invalid_postings");

    const none = evaluateLedgerEntry(balancedDraft({ postings: [] }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("invalid_postings");
  });

  test("balanced but zero-valued legs are rejected (positive amounts only)", () => {
    const zero = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          { account: "platform:deposit_clearing", direction: "debit", amountSantim: 0 },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 0 },
        ],
      }),
    );
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toBe("invalid_posting");
  });

  test("negative and fractional amounts are rejected", () => {
    const negative = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          { account: "platform:deposit_clearing", direction: "debit", amountSantim: -5_00 },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: -5_00 },
        ],
      }),
    );
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.reason).toBe("invalid_posting");

    const fractional = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          { account: "platform:deposit_clearing", direction: "debit", amountSantim: 10.5 },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 10.5 },
        ],
      }),
    );
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.reason).toBe("invalid_posting");
  });
});

/* ── Chart-of-accounts / userSide discipline ── */

describe("posting discipline", () => {
  test("wallet account without userSide is rejected", () => {
    const result = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          { account: "platform:deposit_clearing", direction: "debit", amountSantim: 100_00 },
          { account: `wallet:${USER}`, direction: "credit", amountSantim: 100_00 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_side_required");
  });

  test("wallet account with mismatched userSide is rejected", () => {
    const result = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          { account: "platform:deposit_clearing", direction: "debit", amountSantim: 100_00 },
          {
            account: `wallet:${USER}`,
            userSide: "users:someoneElse" as Id<"users">,
            direction: "credit",
            amountSantim: 100_00,
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_side_mismatch");
  });

  test("platform account with a userSide is rejected", () => {
    const result = evaluateLedgerEntry(
      balancedDraft({
        postings: [
          {
            account: "platform:deposit_clearing",
            userSide: USER,
            direction: "debit",
            amountSantim: 100_00,
          },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 100_00 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_side_forbidden");
  });

  test("closed vocabulary: unknown kind/refType rejected", () => {
    const badKind = evaluateLedgerEntry(
      balancedDraft({ kind: "bonus" as LedgerEntryDraft["kind"] }),
    );
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.reason).toBe("invalid_kind");

    const badRef = evaluateLedgerEntry(
      balancedDraft({ refType: "unicorn" as LedgerEntryDraft["refType"] }),
    );
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.reason).toBe("invalid_ref_type");
  });
});

/* ── Provenance (FROZEN carrier) ── */

describe("provenance preservation", () => {
  test("refund crediting a wallet without provenance lots is rejected", () => {
    const result = evaluateLedgerEntry(
      balancedDraft({
        kind: "refund",
        refType: "bid",
        postings: [
          { account: "platform:bid_fee_revenue", direction: "debit", amountSantim: 3_00 },
          { account: `wallet:${USER}`, userSide: USER, direction: "credit", amountSantim: 3_00 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provenance_required");
  });

  test("refund crediting a wallet with lots is accepted and carries them verbatim", () => {
    const lots = [LOT_1, LOT_2];
    const draft = balancedDraft({
      kind: "refund",
      refType: "bid",
      postings: [
        { account: "platform:bid_fee_revenue", direction: "debit", amountSantim: 3_00 },
        {
          account: `wallet:${USER}`,
          userSide: USER,
          direction: "credit",
          amountSantim: 3_00,
          provenanceLotIds: lots,
        },
      ],
    });
    const result = evaluateLedgerEntry(draft);
    expect(result.ok).toBe(true);
    expect(draft.postings[1]?.provenanceLotIds).toEqual(lots);
  });

  test("non-refund wallet credits do not require provenance", () => {
    expect(evaluateLedgerEntry(balancedDraft()).ok).toBe(true);
  });
});

/* ── Reconciliation calculations ── */

describe("reconciliation helpers", () => {
  const depositPair = [
    { account: "platform:deposit_clearing", direction: "debit" as const, amountSantim: 100_00 },
    { account: `wallet:${USER}`, userSide: USER, direction: "credit" as const, amountSantim: 100_00 },
  ];

  test("transactionBalance of a balanced entry is exactly zero", () => {
    expect(transactionBalance(depositPair)).toBe(0);
  });

  test("transactionBalance exposes an imbalance", () => {
    expect(
      transactionBalance([
        ...depositPair,
        { account: "platform:bid_fee_revenue", direction: "debit", amountSantim: 5 },
      ]),
    ).toBe(5);
  });

  test("accountBalances groups mixed postings per account", () => {
    const balances = accountBalances([
      ...depositPair,
      { account: `wallet:${USER}`, userSide: USER, direction: "debit", amountSantim: 5_00 },
      { account: "platform:bid_fee_revenue", direction: "credit", amountSantim: 5_00 },
    ]);
    // Platform-books perspective: wallet net = debit − credit = 5_00 − 100_00.
    expect(balances.get(`wallet:${USER}`)).toBe(-95_00);
    expect(balances.get("platform:deposit_clearing")).toBe(100_00);
    expect(balances.get("platform:bid_fee_revenue")).toBe(-5_00);
  });

  test("accountBalance returns zero for absent accounts", () => {
    expect(accountBalance(depositPair, "platform:withdrawal_clearing")).toBe(0);
  });

  test("walletReconciliation: funded wallet matches (credit-positive perspective)", () => {
    const result = walletReconciliation({ userId: USER, availableSantim: 100_00 }, depositPair);
    expect(result.ledgerBalanceSantim).toBe(100_00);
    expect(result.differenceSantim).toBe(0);
    expect(result.matches).toBe(true);
  });

  test("walletReconciliation: fee debits reduce the reconciled balance", () => {
    const postings = [
      ...depositPair,
      { account: `wallet:${USER}`, userSide: USER, direction: "debit" as const, amountSantim: 5_00 },
      { account: "platform:bid_fee_revenue", direction: "credit" as const, amountSantim: 5_00 },
    ];
    const result = walletReconciliation({ userId: USER, availableSantim: 95_00 }, postings);
    expect(result.ledgerBalanceSantim).toBe(95_00);
    expect(result.matches).toBe(true);
  });

  test("walletReconciliation: projection drift produces the exception input", () => {
    const result = walletReconciliation({ userId: USER, availableSantim: 90_00 }, depositPair);
    expect(result.matches).toBe(false);
    expect(result.differenceSantim).toBe(-10_00);
  });
});

/* ── postLedgerTransaction — idempotent posting (fake-db end-to-end) ── */

/**
 * In-memory db fake satisfying the structural shapes used by the ledger
 * primitive, the idempotency foundation, and the audit foundation. It has
 * NO update/delete methods by construction — mirroring the append-only
 * journal. Convex OCC rollback is a real-transaction property; the fake
 * documents the primitive's no-cleanup, error-propagating behavior instead.
 */
function makeLedgerDb(options: { failOnInsertOf?: string } = {}) {
  const entries: Array<Record<string, unknown> & { _id: string }> = [];
  const postings: Array<Record<string, unknown> & { _id: string }> = [];
  const idem: Array<Record<string, unknown> & { _id: string }> = [];
  const audits: Array<Record<string, unknown> & { _id: string }> = [];
  let seq = 0;
  const db = {
    async insert(table: string, doc: Record<string, unknown>) {
      if (options.failOnInsertOf === table) throw new Error(`simulated ${table} failure`);
      seq += 1;
      const row: Record<string, unknown> & { _id: string } = { _id: `${table}:${seq}`, ...doc };
      if (table === "ledgerEntries") entries.push(row);
      else if (table === "ledgerPostings") {
        if (!entries.some((e) => e._id === row.entryId)) throw new Error("orphan posting");
        postings.push(row);
      } else if (table === "idempotencyRecords") idem.push(row);
      else if (table === "auditEvents") audits.push(row);
      return row._id;
    },
    query(table: string) {
      return {
        withIndex(
          _name: string,
          fn: (q: { eq: (field: string, value: string) => unknown }) => unknown,
        ) {
          let captured: unknown;
          fn({
            eq: (_field: string, value: string) => {
              captured = value;
              return captured;
            },
          });
          const rows = table === "idempotencyRecords" ? idem : [];
          return {
            async unique() {
              return rows.find((r) => r.key === captured) ?? null;
            },
          };
        },
      };
    },
  };
  return { db, entries, postings, idem, audits };
}

const OTHER = "users:u2" as Id<"users">;

function depositInputFor(owner: Id<"users">, amount = 100_00) {
  return {
    kind: "deposit" as const,
    refType: "paymentEvent" as const,
    refId: "paymentEvents:p1",
    postings: [
      { account: "platform:deposit_clearing", direction: "debit" as const, amountSantim: amount },
      {
        account: `wallet:${owner}`,
        userSide: owner,
        direction: "credit" as const,
        amountSantim: amount,
      },
    ],
    ownerUserId: owner,
    idempotencyToken: "tok-deposit-1",
    idempotencyOp: "deposit_confirm" as const,
  };
}

describe("postLedgerTransaction", () => {
  test("first execution posts entry + postings + idempotency + audit", async () => {
    const store = makeLedgerDb();
    const result = await postLedgerTransaction(store, depositInputFor(USER));
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "posted") throw new Error("expected posted");

    expect(store.entries.length).toBe(1);
    expect(store.postings.length).toBe(2);
    expect(store.idem.length).toBe(1);
    expect(store.audits.length).toBe(1);

    const entry = store.entries[0];
    expect(entry.idempotencyKey).toBe(`luba:idem:deposit_confirm:${USER}:tok-deposit-1`);
    for (const posting of store.postings) {
      expect(posting.entryId).toBe(result.entryId);
    }
  });

  test("exact replay returns the original outcome with zero economic effect", async () => {
    const store = makeLedgerDb();
    const first = await postLedgerTransaction(store, depositInputFor(USER));
    expect(first.ok).toBe(true);

    const replay = await postLedgerTransaction(store, depositInputFor(USER));
    expect(replay.ok).toBe(true);
    if (!replay.ok || replay.status !== "replay") throw new Error("expected replay");
    if (!first.ok || first.status !== "posted") throw new Error("expected first posted");
    expect(replay.outcome).toBe(first.outcome);
    expect(replay.entryId).toBe(first.entryId);

    // Nothing was written twice.
    expect(store.entries.length).toBe(1);
    expect(store.postings.length).toBe(2);
    expect(store.audits.length).toBe(1);
  });

  test("changed request with the same key is a conflict with zero effect", async () => {
    const store = makeLedgerDb();
    await postLedgerTransaction(store, depositInputFor(USER, 100_00));
    const before = { e: store.entries.length, p: store.postings.length, a: store.audits.length };

    const conflict = await postLedgerTransaction(store, depositInputFor(USER, 50_00));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("idempotency_conflict");

    expect(store.entries.length).toBe(before.e);
    expect(store.postings.length).toBe(before.p);
    expect(store.audits.length).toBe(before.a);
  });

  test("same token from a different user is a different key — no cross-user replay", async () => {
    const store = makeLedgerDb();
    await postLedgerTransaction(store, depositInputFor(USER));
    const second = await postLedgerTransaction(store, depositInputFor(OTHER));
    expect(second.ok).toBe(true);
    if (!second.ok || second.status !== "posted") throw new Error("expected second posted");
    expect(store.entries.length).toBe(2);
    const keys = store.entries.map((e) => e.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("invalid and unbalanced drafts are rejected before ANY write", async () => {
    const store = makeLedgerDb();
    const unbalanced = {
      ...depositInputFor(USER),
      postings: [
        { account: "platform:deposit_clearing", direction: "debit" as const, amountSantim: 100_00 },
        { account: `wallet:${USER}`, userSide: USER, direction: "credit" as const, amountSantim: 90_00 },
      ],
    };
    const result = await postLedgerTransaction(store, unbalanced);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unbalanced_entry");
    expect(store.entries.length).toBe(0);
    expect(store.postings.length).toBe(0);
    expect(store.idem.length).toBe(0);
    expect(store.audits.length).toBe(0);
  });
});

/* ── Append-only behavior, atomic failure, audit hygiene ── */

describe("append-only journal", () => {
  test("corrections are new entries; originals are never mutated", async () => {
    const store = makeLedgerDb();
    const first = await postLedgerTransaction(store, depositInputFor(USER));
    expect(first.ok).toBe(true);
    const original = { ...store.entries[0] };

    // A later, different deposit (new key) appends a NEW entry — the first
    // row stays byte-identical (no update path exists at all).
    const second = await postLedgerTransaction(store, {
      ...depositInputFor(USER),
      idempotencyToken: "tok-deposit-2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.status !== "posted") throw new Error("expected posted");

    expect(store.entries.length).toBe(2);
    expect(store.entries[0]).toEqual(original);
  });

  test("a mid-posting failure propagates — no cleanup writes, caller transaction aborts", async () => {
    const store = makeLedgerDb({ failOnInsertOf: "ledgerPostings" });
    let threw = false;
    try {
      await postLedgerTransaction(store, depositInputFor(USER));
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("simulated ledgerPostings failure");
    }
    expect(threw).toBe(true);
    // The primitive never swallows the error and never "fixes up" partial
    // state with compensating writes: in Convex the surrounding transaction
    // aborts (OCC), so neither entry, postings, registry, nor audit persist.
  });

  test("audit rows carry no secrets and map actions from the closed vocabulary", async () => {
    const store = makeLedgerDb();
    await postLedgerTransaction(store, depositInputFor(USER));
    const audit = store.audits[0];
    expect(audit.action).toBe("deposit.confirmed");
    expect(audit.entityType).toBe("ledgerEntries");
    expect(audit.actorId).toBe(USER);
    expect(audit.actorRole).toBe("user");
    const meta = audit.meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["kind", "postingCount", "refId", "refType"]);
    const serialized = JSON.stringify(audit).toLowerCase();
    for (const banned of ["otp", "token\":", "receipturl", "password", "cardnumber"]) {
      expect(serialized).not.toContain(banned);
    }
  });

  test("system ops (null owner) attribute the audit row to the system actor", async () => {
    const store = makeLedgerDb();
    const input = {
      ...depositInputFor(USER),
      ownerUserId: null,
      idempotencyOp: "deposit_confirm" as const,
    };
    const result = await postLedgerTransaction(store, input);
    expect(result.ok).toBe(true);
    const audit = store.audits[0];
    expect(audit.actorId).toBeNull();
    expect(audit.actorRole).toBe("system");
  });
});
