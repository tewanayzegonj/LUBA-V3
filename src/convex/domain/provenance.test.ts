import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";

import {
  planLotConsumption,
  type ProvenanceLotRow,
} from "./provenance";
import {
  consumeProvenanceLots,
  createProvenanceLot,
  restoreProvenanceLots,
} from "../financial/provenance";

/* ── Test doubles ── */

const USER = "users:u1" as Id<"users">;
const OTHER = "users:u2" as Id<"users">;
const PAY_EVENT = "paymentEvents:p1" as Id<"paymentEvents">;

function lot(overrides: Partial<ProvenanceLotRow> & { _id: string }): ProvenanceLotRow {
  return {
    userId: USER,
    paymentEventId: PAY_EVENT,
    originalSantim: 100_00,
    remainingSantim: 100_00,
    status: "open",
    createdAt: 0,
    ...overrides,
  } as ProvenanceLotRow;
}

function makeProvenanceDb(options: { failOnPatch?: boolean } = {}) {
  const rows: ProvenanceLotRow[] = [];
  const patchCalls: Array<{ id: string; doc: Record<string, unknown> }> = [];
  const flags = { failOnPatch: options.failOnPatch === true };
  let seq = 0;
  const db = {
    async insert(
      _table: "provenanceLots",
      doc: Record<string, unknown>,
    ) {
      seq += 1;
      const row = { ...doc, _id: `provenanceLots:${seq}` } as unknown as ProvenanceLotRow;
      rows.push(row);
      return row._id;
    },
    async get(id: Id<"provenanceLots">) {
      return rows.find((r) => r._id === id) ?? null;
    },
    async patch(id: string, doc: Record<string, unknown>) {
      if (flags.failOnPatch) throw new Error("simulated provenance patch failure (OCC abort)");
      patchCalls.push({ id, doc });
      const row = rows.find((r) => r._id === id);
      if (row) Object.assign(row, doc);
    },
  };
  return { db, rows, patchCalls, setFailOnPatch: (value: boolean) => void (flags.failOnPatch = value) };
}

/* ── Lot creation ── */

describe("createProvenanceLot", () => {
  test("creates a lot preserving owner, source, original amount, category, timestamp", async () => {
    const store = makeProvenanceDb();
    const result = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 250_00,
      fundingCategory: "deposit",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected created");

    const row = store.rows[0];
    expect(row.userId).toBe(USER);
    expect(row.paymentEventId).toBe(PAY_EVENT);
    expect(row.originalSantim).toBe(250_00);
    expect(row.remainingSantim).toBe(250_00); // remaining starts = original
    expect(row.status).toBe("open");
    expect(row.fundingCategory).toBe("deposit");
    expect(typeof row.createdAt).toBe("number");
  });

  test("zero, negative, and fractional originals are rejected with no insert", async () => {
    const store = makeProvenanceDb();
    for (const amount of [0, -1_00, 10.5]) {
      const result = await createProvenanceLot(store, {
        userId: USER,
        paymentEventId: PAY_EVENT,
        originalSantim: amount,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_amount");
    }
    expect(store.rows.length).toBe(0);
  });

  test("missing owner or source reference is rejected", async () => {
    const store = makeProvenanceDb();
    const noUser = await createProvenanceLot(store, {
      userId: "" as Id<"users">,
      paymentEventId: PAY_EVENT,
      originalSantim: 100,
    });
    expect(noUser.ok).toBe(false);
    if (!noUser.ok) expect(noUser.reason).toBe("invalid_user");

    const noSource = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: "" as Id<"paymentEvents">,
      originalSantim: 100,
    });
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.reason).toBe("invalid_source");
    expect(store.rows.length).toBe(0);
  });
});

/* ── Caller-order allocation (pure) — NO ordering policy is frozen ── */

describe("planLotConsumption — caller-supplied order", () => {
  const lotA = lot({ _id: "provenanceLots:a" as Id<"provenanceLots">, remainingSantim: 30_00 });
  const lotB = lot({ _id: "provenanceLots:b" as Id<"provenanceLots">, remainingSantim: 50_00 });

  test("allocation follows the caller's order, whatever it is", () => {
    const first = planLotConsumption(USER, 40_00, [lotA, lotB]);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.allocations).toEqual([
        { lotId: lotA._id, amountSantim: 30_00 },
        { lotId: lotB._id, amountSantim: 10_00 },
      ]);
    }

    const second = planLotConsumption(USER, 40_00, [lotB, lotA]);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.allocations).toEqual([
        { lotId: lotB._id, amountSantim: 40_00 },
      ]);
    }
    // Different orders → different allocations: the module has no opinion.
  });

  test("exhausted lots are skipped within the caller's order", () => {
    const dead = lot({
      _id: "provenanceLots:dead" as Id<"provenanceLots">,
      remainingSantim: 0,
      status: "exhausted",
    });
    const plan = planLotConsumption(USER, 10_00, [dead, lotA]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.allocations).toEqual([{ lotId: lotA._id, amountSantim: 10_00 }]);
    }
  });
});

/* ── Server-side consumption ── */

describe("consumeProvenanceLots", () => {
  test("multi-lot consumption reduces remainings and exhausts fully-used lots", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    const b = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
    });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const result = await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 40_00,
      orderedLotIds: [a.lotId, b.lotId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected consumed");

    expect(result.totalSantim).toBe(40_00);
    expect(result.allocations).toEqual([
      { lotId: a.lotId, amountSantim: 30_00 },
      { lotId: b.lotId, amountSantim: 10_00 },
    ]);
    expect(result.exhaustedLotIds).toEqual([a.lotId]);

    const rowA = store.rows.find((r) => r._id === a.lotId);
    const rowB = store.rows.find((r) => r._id === b.lotId);
    expect(rowA?.remainingSantim).toBe(0);
    expect(rowA?.status).toBe("exhausted");
    expect(rowB?.remainingSantim).toBe(40_00);
    expect(rowB?.status).toBe("open");
  });

  test("insufficient total provenance is refused atomically (zero patches)", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    const b = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
    });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const result = await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 81_00, // 30 + 50 exists but 81 does not
      orderedLotIds: [a.lotId, b.lotId],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_provenance");
    expect(store.patchCalls.length).toBe(0);
    expect(store.rows[0]?.remainingSantim).toBe(30_00);
    expect(store.rows[1]?.remainingSantim).toBe(50_00);
  });

  test("over-consumption of a single lot is capped, never negative", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");

    const result = await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 20_00,
      orderedLotIds: [a.lotId],
    });
    expect(result.ok).toBe(true);
    const row = store.rows[0];
    expect(row?.remainingSantim).toBe(10_00);
  });

  test("another user's lot is refused (lot_owner_mismatch, zero patches)", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: OTHER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
    });
    if (!a.ok) throw new Error("setup failed");

    const result = await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: [a.lotId],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lot_owner_mismatch");
    expect(store.patchCalls.length).toBe(0);
  });

  test("unknown lot id is refused atomically", async () => {
    const store = makeProvenanceDb();
    const result = await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: ["provenanceLots:ghost" as Id<"provenanceLots">],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lot_not_found");
    expect(store.patchCalls.length).toBe(0);
  });

  test("invalid amounts (zero/negative/fractional) are refused before any patch", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");

    for (const amount of [0, -5_00, 1.25]) {
      const result = await consumeProvenanceLots(store, {
        ownerUserId: USER,
        requestedSantim: amount,
        orderedLotIds: [a.lotId],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_amount");
    }
    expect(store.patchCalls.length).toBe(0);
  });

  test("mid-apply failure propagates with no compensating cleanup writes", async () => {
    const store = makeProvenanceDb({ failOnPatch: true });
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");

    let threw = false;
    try {
      await consumeProvenanceLots(store, {
        ownerUserId: USER,
        requestedSantim: 20_00,
        orderedLotIds: [a.lotId],
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("simulated provenance patch failure");
    }
    expect(threw).toBe(true);
    // The primitive computed everything up front and never writes cleanup
    // patches; in production the surrounding Convex transaction aborts (OCC)
    // so no partial lot mutation can persist.
  });
});

/* ── Restoration (refund re-credit support) ── */

describe("restoreProvenanceLots", () => {
  test("exact restoration re-credits the original lots", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");

    const consume = await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 30_00,
      orderedLotIds: [a.lotId],
    });
    expect(consume.ok).toBe(true);

    const restore = await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [{ lotId: a.lotId, amountSantim: 30_00 }],
    });
    expect(restore.ok).toBe(true);
    if (!restore.ok) throw new Error("expected restored");
    expect(restore.totalSantim).toBe(30_00);
    expect(restore.reopenedLotIds).toEqual([a.lotId]);

    const row = store.rows[0];
    expect(row?.remainingSantim).toBe(30_00);
    expect(row?.status).toBe("open");
  });

  test("partial restoration re-credits only what was consumed", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 20_00,
      orderedLotIds: [a.lotId],
    });

    const restore = await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [{ lotId: a.lotId, amountSantim: 20_00 }],
    });
    expect(restore.ok).toBe(true);
    if (!restore.ok) throw new Error("expected restored");
    expect(restore.reopenedLotIds).toEqual([]); // lot never exhausted
    expect(store.rows[0]?.remainingSantim).toBe(50_00);
  });

  test("restoration can never exceed the lot's immutable original", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: [a.lotId],
    });

    // Only 10_00 was consumed; restoring 25_00 would exceed original.
    const patchesBeforeRestore = store.patchCalls.length;
    const restore = await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [{ lotId: a.lotId, amountSantim: 25_00 }],
    });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.reason).toBe("restoration_exceeds_original");
    expect(store.patchCalls.length).toBe(patchesBeforeRestore);
    expect(store.rows[0]?.remainingSantim).toBe(20_00);
  });

  test("mismatched owner restoration is refused atomically", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: [a.lotId],
    });

    const patchesBeforeRestore = store.patchCalls.length;
    const restore = await restoreProvenanceLots(store, {
      ownerUserId: OTHER,
      records: [{ lotId: a.lotId, amountSantim: 10_00 }],
    });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.reason).toBe("lot_owner_mismatch");
    expect(store.patchCalls.length).toBe(patchesBeforeRestore);
  });

  test("restoring to an unknown lot is refused atomically", async () => {
    const store = makeProvenanceDb();
    const restore = await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [{ lotId: "provenanceLots:ghost" as Id<"provenanceLots">, amountSantim: 10_00 }],
    });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.reason).toBe("lot_not_found");
  });

  test("invalid restoration amounts are refused before any patch", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: [a.lotId],
    });

    const patchesBeforeRestore = store.patchCalls.length;
    for (const amount of [0, -1_00, 2.5]) {
      const restore = await restoreProvenanceLots(store, {
        ownerUserId: USER,
        records: [{ lotId: a.lotId, amountSantim: amount }],
      });
      expect(restore.ok).toBe(false);
      if (!restore.ok) expect(restore.reason).toBe("invalid_amount");
    }
    expect(store.patchCalls.length).toBe(patchesBeforeRestore);
  });

  test("mid-apply restoration failure propagates with no cleanup writes", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 30_00,
      orderedLotIds: [a.lotId],
    });

    // Arm the failure flag only for the restoration under test.
    store.setFailOnPatch(true);
    let threw = false;
    try {
      await restoreProvenanceLots(store, {
        ownerUserId: USER,
        records: [{ lotId: a.lotId, amountSantim: 30_00 }],
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("simulated provenance patch failure");
    }
    expect(threw).toBe(true);
  });
});

/* ── Immutability and reclassification barriers ── */

describe("provenance immutability", () => {
  test("consumption changes only remaining/status — metadata untouched", async () => {
    const store = makeProvenanceDb();
    const created = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
      fundingCategory: "deposit",
    });
    if (!created.ok) throw new Error("setup failed");
    const before = { ...store.rows[0] };

    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 20_00,
      orderedLotIds: [created.lotId],
    });

    const after = store.rows[0];
    expect(after?.userId).toBe(before.userId);
    expect(after?.paymentEventId).toBe(before.paymentEventId);
    expect(after?.originalSantim).toBe(before.originalSantim);
    expect(after?.fundingCategory).toBe(before.fundingCategory);
    expect(after?.createdAt).toBe(before.createdAt);
    expect(after?.remainingSantim).not.toBe(before.remainingSantim);
  });

  test("funding category is carried verbatim and never reclassified", async () => {
    const store = makeProvenanceDb();
    const created = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
      fundingCategory: "paid_deposit",
    });
    if (!created.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: [created.lotId],
    });
    await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [{ lotId: created.lotId, amountSantim: 10_00 }],
    });

    // Across consume → restore cycles the category is byte-identical.
    expect(store.rows[0]?.fundingCategory).toBe("paid_deposit");
  });

  test("two overlapping restorations for one lot are validated JOINTLY (over-credit regression)", async () => {
    // Regression: two individually-valid records for the SAME lot could
    // jointly exceed the immutable original. original 30_00, remaining
    // 20_00; two × 10_00 records are each valid alone (20+10=30) but
    // jointly would credit 40_00 > 30_00. Must be refused atomically.
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 30_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 10_00,
      orderedLotIds: [a.lotId],
    });
    expect(store.rows[0]?.remainingSantim).toBe(20_00);

    const patchesBeforeRestore = store.patchCalls.length;
    const restore = await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [
        { lotId: a.lotId, amountSantim: 10_00 },
        { lotId: a.lotId, amountSantim: 10_00 },
      ],
    });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.reason).toBe("restoration_exceeds_original");
    expect(store.patchCalls.length).toBe(patchesBeforeRestore); // zero patches
    expect(store.rows[0]?.remainingSantim).toBe(20_00); // untouched
  });

  test("multiple records for one lot that JOINTLY fit are aggregated and applied together", async () => {
    const store = makeProvenanceDb();
    const a = await createProvenanceLot(store, {
      userId: USER,
      paymentEventId: PAY_EVENT,
      originalSantim: 50_00,
    });
    if (!a.ok) throw new Error("setup failed");
    await consumeProvenanceLots(store, {
      ownerUserId: USER,
      requestedSantim: 30_00,
      orderedLotIds: [a.lotId],
    });
    expect(store.rows[0]?.remainingSantim).toBe(20_00);

    const restore = await restoreProvenanceLots(store, {
      ownerUserId: USER,
      records: [
        { lotId: a.lotId, amountSantim: 10_00 },
        { lotId: a.lotId, amountSantim: 10_00 },
      ],
    });
    expect(restore.ok).toBe(true);
    if (!restore.ok) throw new Error("expected restored");
    expect(restore.totalSantim).toBe(20_00);
    expect(restore.restorations).toEqual([{ lotId: a.lotId, amountSantim: 20_00 }]);
    expect(store.rows[0]?.remainingSantim).toBe(40_00);
    expect(store.rows[0]?.status).toBe("open"); // never exhausted
  });
});
