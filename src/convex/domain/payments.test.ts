import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";
import type { ConfirmationSource } from "./contracts";
import type { ProviderEventRejection } from "./payments";
import {
  evaluatePaymentTransition,
  isLegalPaymentTransition,
  normalizeProviderEvent,
  paymentEventDraft,
  paymentEventReference,
  providerEventStorageRecord,
  type IngestedProviderEvent,
} from "./payments";
import {
  confirmPaymentEvent,
  type ConfirmPaymentInput,
  type PaymentEventRow,
} from "../financial/paymentConfirmation";
import {
  getPaymentAdapter,
  isPaymentProviderAdapter,
  registerPaymentAdapter,
  type AdapterEventClaims,
  type PaymentInitiation,
  type PaymentProviderAdapter,
} from "../financial/paymentAdapter";

/* ── Shared fixtures ── */

const USER = "users:u1" as Id<"users">;
const OTHER = "users:u2" as Id<"users">;
const NOW = 1_700_000_000_000;
const REFERENCE = "pay:chapa:deposit:etb:users:u1:10000:1700000000000";

function unverifiedEvent(overrides: Partial<IngestedProviderEvent> = {}): IngestedProviderEvent {
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

function serverRow(overrides: Partial<PaymentEventRow> = {}): PaymentEventRow {
  return {
    _id: "paymentEvents:p1" as Id<"paymentEvents">,
    userId: USER,
    provider: "chapa",
    amountSantim: 100_00,
    status: "pending_confirmation",
    initiatedAt: NOW,
    ...overrides,
  };
}

/* ── 1. Payment status transitions ── */

describe("payment status transitions", () => {
  test("legal transitions are accepted", () => {
    expect(evaluatePaymentTransition("initiated", "pending_confirmation").ok).toBe(true);
    expect(evaluatePaymentTransition("initiated", "failed").ok).toBe(true);
    expect(evaluatePaymentTransition("pending_confirmation", "confirmed").ok).toBe(true);
    expect(evaluatePaymentTransition("pending_confirmation", "failed").ok).toBe(true);
  });

  test("terminal states never transition again", () => {
    expect(evaluatePaymentTransition("confirmed", "confirmed").ok).toBe(false);
    expect(evaluatePaymentTransition("confirmed", "failed").ok).toBe(false);
    expect(evaluatePaymentTransition("confirmed", "pending_confirmation").ok).toBe(false);
    expect(evaluatePaymentTransition("failed", "pending_confirmation").ok).toBe(false);
    expect(evaluatePaymentTransition("failed", "confirmed").ok).toBe(false);
    expect(isLegalPaymentTransition("initiated", "initiated")).toBe(false);
  });

  test("skipping the pending stage is illegal", () => {
    expect(evaluatePaymentTransition("initiated", "confirmed").ok).toBe(false);
  });
});

/* ── 2. Server-derived payment identity ── */

describe("payment identity (server-derived)", () => {
  test("reference derives deterministically from server fields only", () => {
    const a = paymentEventDraft({
      userId: USER,
      provider: "chapa",
      purpose: "deposit",
      amountSantim: 100_00,
      now: NOW,
    });
    const b = paymentEventDraft({
      userId: USER,
      provider: "chapa",
      purpose: "deposit",
      amountSantim: 100_00,
      now: NOW,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("draft failed");

    expect(a.reference).toBe(b.reference);
    expect(a.reference).toBe(REFERENCE);
    expect(a.row.status).toBe("initiated");
    expect(a.row.amountSantim).toBe(100_00);
    expect(a.row.providerRef).toBeUndefined();
  });

  test("draft validation: invalid amounts, empty user, unknown purpose", () => {
    for (const amountSantim of [0, -5_00, 10.5]) {
      const result = paymentEventDraft({
        userId: USER,
        provider: "chapa",
        purpose: "deposit",
        amountSantim,
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_amount");
    }
    const noUser = paymentEventDraft({
      userId: "" as Id<"users">,
      provider: "chapa",
      purpose: "deposit",
      amountSantim: 100_00,
      now: NOW,
    });
    expect(noUser.ok).toBe(false);
    if (!noUser.ok) expect(noUser.reason).toBe("invalid_user");

    const badPurpose = paymentEventDraft({
      userId: USER,
      provider: "chapa",
      purpose: "payout" as never,
      amountSantim: 100_00,
      now: NOW,
    });
    expect(badPurpose.ok).toBe(false);
    if (!badPurpose.ok) expect(badPurpose.reason).toBe("invalid_purpose");
  });

  test("reference recomputes identically from a stored row", () => {
    expect(paymentEventReference(serverRow())).toBe(REFERENCE);
  });
});

/* ── 3. Provider-event ingestion (untrusted until verified) ── */

describe("provider event ingestion", () => {
  test("claims normalize to unverified events with a payload fingerprint", () => {
    const ingestion = normalizeProviderEvent(
      "chapa",
      {
        providerRef: "prov-txn-001",
        amountSantim: 100_00,
        userId: USER,
        reference: REFERENCE,
        currency: "ETB",
      },
      NOW,
    );
    expect(ingestion.ok).toBe(true);
    if (!ingestion.ok) throw new Error("expected ingested");

    expect(ingestion.event.verification).toBe("unverified");
    expect(ingestion.event.claimedAmountSantim).toBe(100_00);
    expect(ingestion.event.claimedCurrency).toBe("ETB");
    expect(typeof ingestion.event.payloadFingerprint).toBe("string");
    expect(ingestion.event.payloadFingerprint.length).toBeGreaterThan(0);

    const storage = providerEventStorageRecord(ingestion.event);
    expect(storage).toEqual({
      providerRef: "prov-txn-001",
      payloadFingerprint: ingestion.event.payloadFingerprint,
      receivedAt: NOW,
      verification: "unverified",
    });
  });

  test("non-ETB currency claims are rejected at ingestion", () => {
    const usd = normalizeProviderEvent(
      "chapa",
      { providerRef: "x", amountSantim: 100_00, userId: USER, reference: "ref", currency: "USD" },
      NOW,
    );
    expect(usd.ok).toBe(false);
    if (!usd.ok) expect(usd.reason).toBe("currency_mismatch");
  });

  test("missing claims are rejected with stable reasons", () => {
    const cases: Array<{ claims: Record<string, unknown>; reason: ProviderEventRejection }> = [
      { claims: {}, reason: "missing_provider_ref" },
      { claims: { providerRef: "x" }, reason: "missing_user_claim" },
      { claims: { providerRef: "x", userId: USER }, reason: "missing_reference_claim" },
      {
        claims: { providerRef: "x", userId: USER, reference: "ref" },
        reason: "missing_amount_claim",
      },
    ];
    for (const c of cases) {
      const r = normalizeProviderEvent("chapa", c.claims, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(c.reason);
    }
  });

  test("non-numeric amount claims are rejected as invalid", () => {
    const r = normalizeProviderEvent(
      "chapa",
      { providerRef: "x", amountSantim: "100.00", userId: USER, reference: "ref", currency: "ETB" },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_amount_claim");
  });
});

/* ── 4. Provider-neutral adapter boundary ── */

describe("payment adapter boundary", () => {
  /** Minimal probe adapter implementing the required contract surface. */
  class ProbeAdapter implements PaymentProviderAdapter {
    readonly provider = "chapa" as const;
    lastInitiation: PaymentInitiation | null = null;

    async initiatePayment(
      initiation: PaymentInitiation,
    ): Promise<{ providerSessionRef: string; redirectUrl: string }> {
      this.lastInitiation = initiation;
      return { providerSessionRef: "sess-1", redirectUrl: "https://provider.example/pay" };
    }

    parseWebhookEvent(raw: unknown) {
      const body = raw as { ref?: string; amount?: number };
      if (typeof body?.ref !== "string") return null;
      const claims: AdapterEventClaims = {
        providerRef: "prov-txn-001",
        amountSantim: body.amount ?? 100_00,
        userId: USER,
        reference: body.ref,
        currency: "ETB",
      };
      return { ok: true as const, claims };
    }

    async verifyEvent(
      claims: AdapterEventClaims,
    ): Promise<
      | { ok: true; verified: boolean; claims?: AdapterEventClaims; source: ConfirmationSource }
      | { ok: false; reason: string; source: ConfirmationSource }
    > {
      return { ok: true, verified: true, claims, source: "webhook" };
    }
  }

  test("registry stores and returns adapters by frozen provider key", () => {
    const probe = new ProbeAdapter();
    registerPaymentAdapter(probe);
    expect(getPaymentAdapter("chapa")).toBe(probe);
    expect(getPaymentAdapter("linkset")).toBeUndefined();
  });

  test("type guard accepts a conforming adapter and rejects junk", () => {
    const probe = new ProbeAdapter();
    expect(isPaymentProviderAdapter(probe)).toBe(true);
    expect(isPaymentProviderAdapter(null)).toBe(false);
    expect(isPaymentProviderAdapter({ provider: "chapa" })).toBe(false);
    expect(isPaymentProviderAdapter("chapa")).toBe(false);
  });

  test("initiation is server-composed data: server fields are preserved verbatim", async () => {
    const probe = new ProbeAdapter();
    registerPaymentAdapter(probe);

    const initiation: PaymentInitiation = {
      userId: USER,
      provider: "chapa",
      purpose: "deposit",
      amountSantim: 100_00,
      currency: "ETB",
      reference: REFERENCE,
      idempotencyToken: "init-token-1",
    };
    await probe.initiatePayment(initiation);
    expect(probe.lastInitiation).toEqual(initiation);
    expect(probe.lastInitiation?.currency).toBe("ETB");
    expect(probe.lastInitiation?.amountSantim).toBe(100_00);
  });

  test("provider webhook output is claims — normalized events stay unverified", () => {
    const probe = new ProbeAdapter();
    const parsed = probe.parseWebhookEvent({ ref: REFERENCE, amount: 100_00 });
    expect(parsed).not.toBeNull();
    if (parsed === null || !parsed.ok) throw new Error("expected parsed");

    const ingestion = normalizeProviderEvent("chapa", parsed.claims, NOW);
    expect(ingestion.ok).toBe(true);
    if (!ingestion.ok) throw new Error("expected ingested");
    // Even after parsing, the event is unverified — only the adapter's
    // server-to-server verifyEvent may flip that.
    expect(ingestion.event.verification).toBe("unverified");
  });

  test("unparseable provider payloads map to null, never to confirmation", () => {
    const probe = new ProbeAdapter();
    expect(probe.parseWebhookEvent({ nope: true })).toBeNull();
    expect(probe.parseWebhookEvent("garbage")).toBeNull();
  });
});

/* ── 5. Confirmation primitive (server-side) ── */

function makePaymentDb(initialRows: PaymentEventRow[] = []) {
  const rows = new Map<string, PaymentEventRow>(initialRows.map((r) => [r._id, r]));
  const idemRows: Array<{ key: string; refType: string; refId: string; outcome: string }> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const confirmationRows: Array<Record<string, unknown>> = [];
  let seq = 0;
  let failOnInsert: string | null = null;

  const db = {
    async get(id: Id<"paymentEvents">) {
      return rows.get(id) ?? null;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      if (failOnInsert === table) throw new Error(`simulated insert failure on ${table}`);
      seq += 1;
      if (table === "paymentConfirmations") confirmationRows.push({ ...doc, _id: `paymentConfirmations:${seq}` });
      else if (table === "idempotencyRecords") idemRows.push(doc as { key: string; refType: string; refId: string; outcome: string });
      else if (table === "auditEvents") auditRows.push(doc);
      return `${table}:${seq}`;
    },
    query(table: string) {
      return {
        withIndex(_name: string, fn: (q: { eq: (f: string, v: string) => unknown }) => unknown) {
          let captured: { field: string; value: string } | null = null;
          fn({ eq: (field, value) => { captured = { field, value }; return captured; } });
          const value = (captured as { field: string; value: string } | null)?.value ?? "";
          if (table === "paymentEvents") {
            return {
              collect: async () => [...rows.values()].filter((r) => r.providerRef === value),
            };
          }
          return {
            unique: async () => idemRows.find((r) => r.key === value) ?? null,
          };
        },
      };
    },
    async patch(id: Id<"paymentEvents">, doc: Record<string, unknown>) {
      const row = rows.get(id);
      if (row) Object.assign(row, doc);
    },
  };

  return {
    db,
    rows,
    idemRows,
    auditRows,
    confirmationRows,
    setFailOnInsert: (table: string | null) => {
      failOnInsert = table;
    },
  };
}

function matchingEvent(row: PaymentEventRow, verification: "unverified" | "verified" = "verified"): IngestedProviderEvent {
  return unverifiedEvent({
    provider: row.provider,
    providerRef: row.providerRef ?? "prov-txn-001",
    claimedAmountSantim: row.amountSantim,
    claimedUserId: row.userId,
    claimedReference: paymentEventReference(row),
    verification,
  });
}

function confirmInput(
  row: PaymentEventRow,
  event: IngestedProviderEvent,
  source: ConfirmationSource = "webhook",
): ConfirmPaymentInput {
  return { paymentEventId: row._id, event, source };
}

describe("confirmPaymentEvent", () => {
  test("successful confirmation: record + status flip + idempotency + audit, all consistent", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);

    const result = await confirmPaymentEvent(store, confirmInput(row, matchingEvent(row)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected confirmed");
    expect(result.replayed).toBe(false);

    expect(store.confirmationRows.length).toBe(1);
    expect(store.confirmationRows[0]?.verified).toBe(true);
    expect(store.rows.get(row._id)?.status).toBe("confirmed");
    expect(typeof store.rows.get(row._id)?.resolvedAt).toBe("number");
    expect(store.idemRows.length).toBe(1);
    expect(store.auditRows.length).toBe(1);
    expect(store.auditRows[0]?.action).toBe("deposit.confirmed");
  });

  test("exact replay with identical claims returns the original outcome with zero effect", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    const event = matchingEvent(row);

    const first = await confirmPaymentEvent(store, confirmInput(row, event));
    expect(first.ok).toBe(true);

    const second = await confirmPaymentEvent(store, confirmInput(row, event));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected replay");
    expect(second.replayed).toBe(true);

    expect(store.confirmationRows.length).toBe(1); // no second confirmation
    expect(store.auditRows.length).toBe(1); // no second audit row
    expect(store.idemRows.length).toBe(1);
  });

  test("confirmation via a different source is the SAME economic event (replay, not conflict)", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    const event = matchingEvent(row);

    const first = await confirmPaymentEvent(store, confirmInput(row, event, "webhook"));
    expect(first.ok).toBe(true);

    const second = await confirmPaymentEvent(store, confirmInput(row, event, "hosted_return"));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected replay");
    expect(second.replayed).toBe(true);
    expect(store.confirmationRows.length).toBe(1);
  });

  test("changed claims for the same event are an idempotency conflict with zero effect", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);

    const first = await confirmPaymentEvent(store, confirmInput(row, matchingEvent(row)));
    expect(first.ok).toBe(true);

    const tampered = matchingEvent(row);
    tampered.claimedAmountSantim = 999_00;
    const second = await confirmPaymentEvent(store, confirmInput(row, tampered));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("idempotency_conflict");

    expect(store.confirmationRows.length).toBe(1);
    expect(store.auditRows.length).toBe(1);
  });

  test("exact amount mismatch is rejected before any write", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    const event = matchingEvent(row);
    event.claimedAmountSantim = 101_00; // server says 100_00

    const result = await confirmPaymentEvent(store, confirmInput(row, event));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("amount_mismatch");

    expect(store.confirmationRows.length).toBe(0);
    expect(store.idemRows.length).toBe(0);
    expect(store.auditRows.length).toBe(0);
    expect(store.rows.get(row._id)?.status).toBe("pending_confirmation");
  });

  test("wrong user claim is rejected (user_mismatch)", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    const event = matchingEvent(row);
    event.claimedUserId = OTHER;

    const result = await confirmPaymentEvent(store, confirmInput(row, event));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_mismatch");
    expect(store.confirmationRows.length).toBe(0);
  });

  test("wrong reference claim is rejected (reference_mismatch)", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    const event = matchingEvent(row);
    event.claimedReference = "pay:chapa:deposit:etb:users:u1:10000:1";

    const result = await confirmPaymentEvent(store, confirmInput(row, event));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reference_mismatch");
    expect(store.confirmationRows.length).toBe(0);
  });

  test("UNVERIFIED events can never reach a financial decision (unverified_event)", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    const event = matchingEvent(row, "unverified");

    const result = await confirmPaymentEvent(store, confirmInput(row, event));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unverified_event");
    expect(store.confirmationRows.length).toBe(0);
    expect(store.idemRows.length).toBe(0);
    expect(store.auditRows.length).toBe(0);
  });

  test("a provider reference can be confirmed exactly once across events (provider_ref_conflict)", async () => {
    const p1 = serverRow({ _id: "paymentEvents:p1" as Id<"paymentEvents">, providerRef: "prov-txn-001" });
    const p2 = serverRow({ _id: "paymentEvents:p2" as Id<"paymentEvents">, providerRef: "prov-txn-001" });
    const store = makePaymentDb([p1, p2]);

    const first = await confirmPaymentEvent(store, confirmInput(p1, matchingEvent(p1)));
    expect(first.ok).toBe(true);

    const second = await confirmPaymentEvent(store, confirmInput(p2, matchingEvent(p2)));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("provider_ref_conflict");
    expect(store.rows.get(p2._id)?.status).toBe("pending_confirmation");
    expect(store.confirmationRows.length).toBe(1);
  });

  test("already-confirmed payment is not confirmable outside replay (defensive)", async () => {
    const row = serverRow({ status: "confirmed", providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);

    const result = await confirmPaymentEvent(store, confirmInput(row, matchingEvent(row)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already_confirmed");
  });

  test("unknown payment event is rejected", async () => {
    const store = makePaymentDb();
    const row = serverRow({ providerRef: "prov-txn-001" });
    const result = await confirmPaymentEvent(store, confirmInput(row, matchingEvent(row)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payment_not_found");
  });

  test("mid-apply failure propagates for OCC rollback; no compensating writes", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);
    store.setFailOnInsert("paymentConfirmations");

    let threw = false;
    try {
      await confirmPaymentEvent(store, confirmInput(row, matchingEvent(row)));
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("simulated insert failure");
    }
    expect(threw).toBe(true);
    expect(store.auditRows.length).toBe(0);
    expect(store.idemRows.length).toBe(0);
  });

  test("no-secret guarantees: confirmation + audit rows carry no credentials/payloads", async () => {
    const row = serverRow({ providerRef: "prov-txn-001" });
    const store = makePaymentDb([row]);

    await confirmPaymentEvent(store, confirmInput(row, matchingEvent(row)));

    const forbidden = ["signature", "secret", "token", "payload", "credential", "apikey"];
    const serialized = JSON.stringify({
      confirmations: store.confirmationRows,
      audit: store.auditRows,
    }).toLowerCase();
    for (const word of forbidden) {
      expect(serialized.includes(word)).toBe(false);
    }
    const auditMeta = store.auditRows[0]?.meta as Record<string, unknown>;
    expect(Object.keys(auditMeta).sort()).toEqual([
      "eventFingerprint",
      "provider",
      "providerRef",
      "source",
    ]);
  });

  test("ingestion drops unknown claim fields (signatures/raw payloads never persisted)", () => {
    const ingestion = normalizeProviderEvent(
      "chapa",
      {
        providerRef: "prov-txn-001",
        amountSantim: 100_00,
        userId: USER,
        reference: REFERENCE,
        currency: "ETB",
        signature: "sig-abc-123",
        rawPayload: { deep: "provider blob" },
      } as Record<string, unknown>,
      NOW,
    );
    expect(ingestion.ok).toBe(true);
    if (!ingestion.ok) throw new Error("expected ingested");

    const storageRecord = JSON.stringify(providerEventStorageRecord(ingestion.event));
    expect(storageRecord.includes("sig-abc-123")).toBe(false);
    expect(storageRecord.includes("provider blob")).toBe(false);
    expect(ingestion.event.payloadFingerprint.includes("sig-abc-123")).toBe(false);
  });
});
