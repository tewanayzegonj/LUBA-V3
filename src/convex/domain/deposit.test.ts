import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";
import type { IngestedProviderEvent } from "./payments";
import { confirmAndJournalDeposit } from "../financial/deposit";
import { restoreProvenanceLots, consumeProvenanceLots } from "../financial/provenance";
import type { ProvenanceLotRow } from "./provenance";
import {
  transactionBalance,
  walletReconciliation,
  type ReconciliationPosting,
} from "./reconciliation";

/* ── Full-store fake: one db serving every financial table ──
 * Reuses the per-table row shapes from the D-phase fakes. Row-level
 * invariants (unique keys) are enforced where the real backend would be. */

const USER = "users:u1" as Id<"users">;
const OTHER = "users:u2" as Id<"users">;
const NOW = 1_700_000_000_000;
const REFERENCE = "pay:chapa:deposit:etb:users:u1:10000:1700000000000";

type PaymentEventRow = {
  _id: Id<"paymentEvents">;
  userId: Id<"users">;
  provider: "chapa" | "linkset";
  providerRef?: string;
  amountSantim: number;
  status: "initiated" | "pending_confirmation" | "confirmed" | "failed";
  initiatedAt: number;
  resolvedAt?: number;
};

type WalletRow = { _id: string; userId: string; availableSantim: number; updatedAt: number };

type LedgerEntryRow = {
  _id: string;
  kind: string;
  refType: string;
  refId: string;
  idempotencyKey: string;
  createdAt: number;
};

type LedgerPostingRow = {
  _id: string;
  entryId: string;
  account: string;
  userSide?: string;
  direction: "debit" | "credit";
  amountSantim: number;
  provenanceLotIds?: string[];
  createdAt: number;
};

type IdempotencyRow = {
  key: string;
  op: string;
  refType: string;
  refId: string;
  outcome: string;
  createdAt: number;
};

type AuditRow = Record<string, unknown>;

function makeFullStore(options: { failOnInsert?: string } = {}) {
  const paymentEvents = new Map<string, PaymentEventRow>();
  const paymentConfirmations: Array<Record<string, unknown>> = [];
  const wallets = new Map<string, WalletRow>();
  const provenanceLots: ProvenanceLotRow[] = [];
  const ledgerEntries: LedgerEntryRow[] = [];
  const ledgerPostings: LedgerPostingRow[] = [];
  const idempotencyRecords = new Map<string, IdempotencyRow>();
  const auditEvents: AuditRow[] = [];
  let seq = 0;
  let failOnInsert = options.failOnInsert ?? null;

  const db = {
    async get(id: string) {
      if (id.startsWith("paymentEvents:")) return paymentEvents.get(id) ?? null;
      if (id.startsWith("wallets:")) return wallets.get(id) ?? null;
      if (id.startsWith("provenanceLots:")) {
        return provenanceLots.find((l) => l._id === id) ?? null;
      }
      return null;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      if (failOnInsert === table) throw new Error(`simulated insert failure on ${table}`);
      seq += 1;
      const id = `${table}:${seq}`;
      const row = { ...doc, _id: id };
      if (table === "paymentEvents") paymentEvents.set(id, row as unknown as PaymentEventRow);
      else if (table === "paymentConfirmations") paymentConfirmations.push(row);
      else if (table === "wallets") wallets.set(id, row as unknown as WalletRow);
      else if (table === "provenanceLots") provenanceLots.push(row as unknown as ProvenanceLotRow);
      else if (table === "ledgerEntries") ledgerEntries.push(row as unknown as LedgerEntryRow);
      else if (table === "ledgerPostings") ledgerPostings.push(row as unknown as LedgerPostingRow);
      else if (table === "idempotencyRecords") idempotencyRecords.set(doc.key as string, row as unknown as IdempotencyRow);
      else if (table === "auditEvents") auditEvents.push(row);
      else throw new Error(`unknown table ${table}`);
      return id;
    },
    query(table: string) {
      return {
        withIndex(name: string, fn: (q: { eq: (f: string, v: string) => unknown }) => unknown) {
          let captured: { field: string; value: string } | null = null;
          fn({ eq: (field, value) => { captured = { field, value }; return captured; } });
          const value = (captured as { field: string; value: string } | null)?.value ?? "";
          if (table === "idempotencyRecords") {
            return {
              unique: async () => idempotencyRecords.get(value) ?? null,
              collect: async () => idempotencyRecords.get(value) ? [idempotencyRecords.get(value)] : [],
            };
          }
          if (table === "wallets") {
            return {
              unique: async () => [...wallets.values()].find((w) => w.userId === value) ?? null,
              collect: async () => [...wallets.values()].filter((w) => w.userId === value),
            };
          }
          if (table === "paymentEvents") {
            return {
              collect: async () => [...paymentEvents.values()].filter((r) => r.providerRef === value),
            };
          }
          return { unique: async () => null, collect: async () => [] };
        },
      };
    },
    async patch(id: string, doc: Record<string, unknown>) {
      if (id.startsWith("paymentEvents:")) {
        const row = paymentEvents.get(id);
        if (row) Object.assign(row, doc);
        return;
      }
      if (id.startsWith("wallets:")) {
        const row = wallets.get(id);
        if (row) Object.assign(row, doc);
        return;
      }
      if (id.startsWith("provenanceLots:")) {
        const row = provenanceLots.find((l) => l._id === id);
        if (row) Object.assign(row, doc);
      }
    },
  };

  return {
    ctx: { db },
    db,
    paymentEvents,
    paymentConfirmations,
    wallets,
    provenanceLots,
    ledgerEntries,
    ledgerPostings,
    idempotencyRecords,
    auditEvents,
    setFailOnInsert: (table: string | null) => {
      failOnInsert = table;
    },
    /**
     * OCC simulation: snapshot/restore the WHOLE store. A thrown Convex
     * transaction removes ALL of its writes; tests reproduce that by
     * restoring the snapshot after catching a mid-transaction throw.
     */
    snapshot(): string {
      return JSON.stringify({
        paymentEvents: [...paymentEvents.entries()],
        paymentConfirmations,
        wallets: [...wallets.entries()],
        provenanceLots,
        ledgerEntries,
        ledgerPostings,
        idempotencyRecords: [...idempotencyRecords.entries()],
        auditEvents,
        seq,
      });
    },
    restore(snapshot: string): void {
      const s = JSON.parse(snapshot) as {
        paymentEvents: [string, PaymentEventRow][];
        paymentConfirmations: Record<string, unknown>[];
        wallets: [string, WalletRow][];
        provenanceLots: ProvenanceLotRow[];
        ledgerEntries: LedgerEntryRow[];
        ledgerPostings: LedgerPostingRow[];
        idempotencyRecords: [string, IdempotencyRow][];
        auditEvents: AuditRow[];
        seq: number;
      };
      paymentEvents.clear();
      for (const [k, v] of s.paymentEvents) paymentEvents.set(k, v);
      paymentConfirmations.length = 0;
      paymentConfirmations.push(...s.paymentConfirmations);
      wallets.clear();
      for (const [k, v] of s.wallets) wallets.set(k, v);
      provenanceLots.length = 0;
      provenanceLots.push(...s.provenanceLots);
      ledgerEntries.length = 0;
      ledgerEntries.push(...s.ledgerEntries);
      ledgerPostings.length = 0;
      ledgerPostings.push(...s.ledgerPostings);
      idempotencyRecords.clear();
      for (const [k, v] of s.idempotencyRecords) idempotencyRecords.set(k, v);
      auditEvents.length = 0;
      auditEvents.push(...s.auditEvents);
      seq = s.seq;
    },
  };
}

function verifiedEvent(overrides: Partial<IngestedProviderEvent> = {}): IngestedProviderEvent {
  return {
    provider: "chapa",
    providerRef: "prov-txn-001",
    claimedAmountSantim: 100_00,
    claimedUserId: USER,
    claimedReference: REFERENCE,
    claimedCurrency: "ETB",
    payloadFingerprint: "fp-evidence",
    receivedAt: NOW,
    verification: "unverified",
    ...overrides,
  };
}

function seedPendingPayment(
  store: ReturnType<typeof makeFullStore>,
  overrides: Partial<PaymentEventRow> = {},
): PaymentEventRow {
  const row: PaymentEventRow = {
    _id: "paymentEvents:p1" as Id<"paymentEvents">,
    userId: USER,
    provider: "chapa",
    providerRef: "prov-txn-001",
    amountSantim: 100_00,
    status: "pending_confirmation",
    initiatedAt: NOW,
    ...overrides,
  };
  store.paymentEvents.set(row._id, row);
  return row;
}

/* ── 1. Successful deposit: the full economic effect ── */

describe("confirmAndJournalDeposit — success", () => {
  test("journals the complete deposit effect in one transaction", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);

    const result = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "posted") throw new Error("expected posted");

    // Confirmation state (Backend Schema §5.2):
    expect(store.paymentConfirmations.length).toBe(1);
    expect(store.paymentConfirmations[0]?.verified).toBe(true);
    expect(store.paymentEvents.get(row._id)?.status).toBe("confirmed");

    // Exact wallet increase (integer santims):
    expect(store.wallets.size).toBe(1);
    const wallet = [...store.wallets.values()][0];
    expect(wallet?.userId).toBe(USER);
    expect(wallet?.availableSantim).toBe(100_00);

    // Exact provenance lot creation, tied to the originating payment event:
    expect(store.provenanceLots.length).toBe(1);
    const lot = store.provenanceLots[0];
    expect(lot?.userId).toBe(USER);
    expect(lot?.paymentEventId).toBe(row._id);
    expect(lot?.originalSantim).toBe(100_00);
    expect(lot?.remainingSantim).toBe(100_00);
    expect(lot?.status).toBe("open");
    expect(lot?.fundingCategory).toBeUndefined(); // vocabulary OPEN — unset

    // Balanced ledger result: 1 entry, 2 postings, debits === credits:
    expect(store.ledgerEntries.length).toBe(1);
    expect(store.ledgerEntries[0]?.kind).toBe("deposit");
    expect(store.ledgerEntries[0]?.refType).toBe("paymentEvent");
    expect(store.ledgerEntries[0]?.refId).toBe(row._id);
    expect(store.ledgerPostings.length).toBe(2);
    const debits = store.ledgerPostings
      .filter((p) => p.direction === "debit")
      .reduce((s, p) => s + p.amountSantim, 0);
    const credits = store.ledgerPostings
      .filter((p) => p.direction === "credit")
      .reduce((s, p) => s + p.amountSantim, 0);
    expect(debits).toBe(100_00);
    expect(credits).toBe(100_00);
    expect(transactionBalance(store.ledgerPostings)).toBe(0);

    // Wallet posting is credited (funds in); provider account debited:
    const walletPosting = store.ledgerPostings.find((p) => p.account === `wallet:${USER}`);
    expect(walletPosting?.direction).toBe("credit");
    const providerPosting = store.ledgerPostings.find((p) => p.account === "provider:chapa:settlement");
    expect(providerPosting?.direction).toBe("debit");

    // Idempotency recorded (confirmation + ledger registry entries):
    expect(store.idempotencyRecords.size).toBe(2);
    // Audit recorded (confirmation + ledger + lot are audited effects):
    expect(store.auditEvents.length).toBeGreaterThanOrEqual(2);
  });
});

/* ── 2. Idempotency semantics ── */

describe("confirmAndJournalDeposit — idempotency", () => {
  test("exact replay returns the original outcome with ZERO duplicate effect", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);
    const event = verifiedEvent({ verification: "verified" });

    const first = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id, event, source: "webhook",
    });
    expect(first.ok).toBe(true);
    const before = {
      wallets: store.wallets.size,
      lots: store.provenanceLots.length,
      entries: store.ledgerEntries.length,
      postings: store.ledgerPostings.length,
      confirmations: store.paymentConfirmations.length,
      audits: store.auditEvents.length,
    };

    const second = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id, event, source: "webhook",
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.status !== "replay") throw new Error("expected replay");
    expect(second.ledgerEntryId).not.toBeNull(); // original outcome returned

    expect(store.wallets.size).toBe(before.wallets);
    expect(store.provenanceLots.length).toBe(before.lots);
    expect(store.ledgerEntries.length).toBe(before.entries);
    expect(store.ledgerPostings.length).toBe(before.postings);
    expect(store.paymentConfirmations.length).toBe(before.confirmations);
    expect(store.auditEvents.length).toBe(before.audits);
    const wallet = [...store.wallets.values()][0];
    expect(wallet?.availableSantim).toBe(100_00); // credited exactly once
  });

  test("same economic event through another source is a REPLAY, not a second effect", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);
    const event = verifiedEvent({ verification: "verified" });

    await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id, event, source: "webhook",
    });
    const second = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id, event, source: "hosted_return",
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.status !== "replay") throw new Error("expected replay");

    expect(store.ledgerEntries.length).toBe(1);
    expect(store.wallets.size).toBe(1);
    const wallet = [...store.wallets.values()][0];
    expect(wallet?.availableSantim).toBe(100_00); // never double-credited
  });

  test("changed claims for the same event are a conflict with zero effect", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);

    await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });
    const before = store.ledgerEntries.length;

    const tampered = verifiedEvent({
      verification: "verified",
      claimedAmountSantim: 999_00,
    });
    const second = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id, event: tampered, source: "webhook",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("idempotency_conflict");
    expect(store.ledgerEntries.length).toBe(before);
    const wallet = [...store.wallets.values()][0];
    expect(wallet?.availableSantim).toBe(100_00);
  });

  test("a duplicate provider reference is rejected across payment events", async () => {
    const store = makeFullStore();
    const p1 = seedPendingPayment(store);
    const p2 = seedPendingPayment(store, {
      _id: "paymentEvents:p2" as Id<"paymentEvents">,
    });

    const first = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: p1._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });
    expect(first.ok).toBe(true);

    const second = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: p2._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("provider_ref_conflict");
    expect(store.ledgerEntries.length).toBe(1);
    expect(store.paymentConfirmations.length).toBe(1);
  });
});

/* ── 3. Verification/claim guards ── */

describe("confirmAndJournalDeposit — verification and claim guards", () => {
  test("UNVERIFIED events are rejected before any economic effect", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);

    const result = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "unverified" }),
      source: "webhook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unverified_event");

    expect(store.ledgerEntries.length).toBe(0);
    expect(store.provenanceLots.length).toBe(0);
    expect(store.wallets.size).toBe(0);
    expect(store.paymentConfirmations.length).toBe(0);
  });

  test("wrong amount / user / reference claims are rejected with zero effect", async () => {
    for (const tamper of [
      { key: "amount", patch: { claimedAmountSantim: 101_00 }, reason: "amount_mismatch" },
      { key: "user", patch: { claimedUserId: OTHER }, reason: "user_mismatch" },
      { key: "reference", patch: { claimedReference: "pay:chapa:deposit:etb:x" }, reason: "reference_mismatch" },
    ] as const) {
      const store = makeFullStore();
      const row = seedPendingPayment(store);
      const event = verifiedEvent({ verification: "verified", ...tamper.patch });
      const result = await confirmAndJournalDeposit(store.ctx, {
        paymentEventId: row._id, event, source: "webhook",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(tamper.reason);
      expect(store.ledgerEntries.length).toBe(0);
      expect(store.provenanceLots.length).toBe(0);
      expect(store.wallets.size).toBe(0);
    }
  });

  test("non-ETB currency claims are rejected (currency is frozen)", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);
    const result = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "verified", claimedCurrency: "USD" }),
      source: "webhook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("currency_mismatch");
    expect(store.ledgerEntries.length).toBe(0);
  });

  test("unknown payment event is rejected", async () => {
    const store = makeFullStore();
    const result = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: "paymentEvents:ghost" as Id<"paymentEvents">,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payment_not_found");
  });
});

/* ── 4. Atomicity / OCC safety ── */

describe("confirmAndJournalDeposit — atomicity", () => {
  test("mid-effect failure + OCC rollback leaves ZERO partial effect", async () => {
    const store = makeFullStore({ failOnInsert: "ledgerEntries" });
    const row = seedPendingPayment(store);
    const snapshot = store.snapshot();

    let threw = false;
    try {
      await confirmAndJournalDeposit(store.ctx, {
        paymentEventId: row._id,
        event: verifiedEvent({ verification: "verified" }),
        source: "webhook",
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("simulated insert failure");
    }
    expect(threw).toBe(true);
    // Simulate the Convex transaction abort: restore the pre-transaction
    // snapshot. After rollback, no economic state exists at all.
    store.restore(snapshot);
    expect(store.ledgerEntries.length).toBe(0);
    expect(store.provenanceLots.length).toBe(0);
    expect(store.wallets.size).toBe(0);
    expect(store.paymentConfirmations.length).toBe(0);
    expect(store.idempotencyRecords.size).toBe(0);
    expect(store.auditEvents.length).toBe(0);
    expect(store.paymentEvents.get(row._id)?.status).toBe("pending_confirmation");
  });

  test("retry after a failed attempt succeeds exactly once (OCC retry safety)", async () => {
    const store = makeFullStore({ failOnInsert: "ledgerEntries" });
    const row = seedPendingPayment(store);
    const event = verifiedEvent({ verification: "verified" });
    const snapshot = store.snapshot();

    let threw = false;
    try {
      await confirmAndJournalDeposit(store.ctx, {
        paymentEventId: row._id, event, source: "webhook",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // OCC retry begins from the post-abort state: the failed transaction
    // left nothing behind.
    store.restore(snapshot);
    store.setFailOnInsert(null);

    const retry = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id, event, source: "webhook",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok || retry.status !== "posted") throw new Error("expected posted on retry");

    // Exactly one full effect despite the failed attempt.
    expect(store.ledgerEntries.length).toBe(1);
    expect(store.provenanceLots.length).toBe(1);
    expect(store.wallets.size).toBe(1);
    const wallet = [...store.wallets.values()][0];
    expect(wallet?.availableSantim).toBe(100_00);
  });
});

/* ── 5. Audit safety and reconciliation ── */

describe("confirmAndJournalDeposit — audit and reconciliation", () => {
  test("audit rows carry no credentials/payloads and attribute correctly", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);
    await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });

    const serialized = JSON.stringify(store.auditEvents).toLowerCase();
    for (const word of ["signature", "secret", "credential", "apikey", "receipturl", "otp"]) {
      expect(serialized.includes(word)).toBe(false);
    }
    const confirmationAudit = store.auditEvents.find(
      (a) => a.action === "deposit.confirmed" && a.entityType === "paymentEvents",
    );
    expect(confirmationAudit).toBeDefined();
    expect(confirmationAudit?.actorRole).toBe("system");
    const ledgerAudit = store.auditEvents.find(
      (a) => a.action === "deposit.confirmed" && a.entityType === "ledgerEntries",
    );
    expect(ledgerAudit).toBeDefined();
  });

  test("post-deposit reconciliation: wallet projection matches the ledger exactly", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);
    await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });

    const wallet = [...store.wallets.values()][0];
    const walletPostings: ReconciliationPosting[] = store.ledgerPostings
      .filter((p) => p.account === `wallet:${USER}`)
      .map((p) => ({
        account: p.account,
        direction: p.direction,
        amountSantim: p.amountSantim,
        userSide: p.userSide ?? null,
      }));
    const recon = walletReconciliation(
      { userId: USER, availableSantim: wallet?.availableSantim ?? 0 },
      walletPostings,
    );
    expect(recon.matches).toBe(true);
    expect(recon.ledgerBalanceSantim).toBe(100_00);
    expect(recon.differenceSantim).toBe(0);
  });
});

/* ── 6. Provenance continuity after deposit (lot is consumable/restorable) ── */

describe("deposit provenance continuity", () => {
  test("the created lot can be consumed and restored through the D-phase primitives", async () => {
    const store = makeFullStore();
    const row = seedPendingPayment(store);
    const deposit = await confirmAndJournalDeposit(store.ctx, {
      paymentEventId: row._id,
      event: verifiedEvent({ verification: "verified" }),
      source: "webhook",
    });
    expect(deposit.ok).toBe(true);
    if (!deposit.ok || deposit.status !== "posted") throw new Error("expected posted");

    const consume = await consumeProvenanceLots(store.ctx, {
      ownerUserId: USER,
      requestedSantim: 40_00,
      orderedLotIds: [deposit.provenanceLotId],
    });
    expect(consume.ok).toBe(true);
    expect(store.provenanceLots[0]?.remainingSantim).toBe(60_00);

    const restore = await restoreProvenanceLots(store.ctx, {
      ownerUserId: USER,
      records: [{ lotId: deposit.provenanceLotId, amountSantim: 40_00 }],
    });
    expect(restore.ok).toBe(true);
    expect(store.provenanceLots[0]?.remainingSantim).toBe(100_00);
    expect(store.provenanceLots[0]?.fundingCategory).toBeUndefined(); // never reclassified
  });
});
