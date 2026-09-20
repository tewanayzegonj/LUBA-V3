/**
 * LUBA V1 — prize/inventory foundation tests (Phase F).
 *
 * Harness notes (honest fake semantics):
 *  - `FakeStore` is a versioned in-memory store. Rows are never deleted
 *    (append/history preservation is assertable).
 *  - `makeCtx` wraps the store like a Convex transaction: reads record
 *    (row → version) into a read set; every WRITE re-validates the read set
 *    and throws `OccConflictError` when a read row moved — exactly Convex
 *    OCC's write-conflict abort. `runTx` restarts on conflict (fresh reads),
 *    matching the Convex retry loop; a stale first attempt is injected via
 *    a pre-race snapshot to model a transaction that read pre-commit state.
 *  - `runTxAtomic` deep-snapshots the store before the call and restores it
 *    on ANY throw — modeling Convex's all-or-nothing commit (no partial
 *    state, no compensating cleanup).
 */
import { describe, expect, test } from "bun:test";
import type { Id } from "../_generated/dataModel";

import {
  classifyReserveReplay,
  evaluateInventoryTransition,
  evaluatePrizeDraft,
  evaluateReleaseDispatch,
  evaluateReserve,
  projectPublicPrize,
} from "./inventory";
import {
  createPrizeRow,
  publicPrizeProjection,
  updatePrizeRow,
} from "../inventory/prizes";
import {
  commitReservation,
  reserveInventory,
  resolveReservation,
} from "../inventory/reservations";
import { isProhibitedField } from "../guards/projections";

/* ── Fake store ── */

type Row = Record<string, unknown> & { _id: string };
type Stored = { row: Row; version: number };

class FakeStore {
  private tables = new Map<string, Map<string, Stored>>();
  private seq = 0;
  /** When set, the next insert into this table throws once (mid-tx failure). */
  failNextInsert: string | null = null;

  private tableOf(table: string): Map<string, Stored> {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new Map();
      this.tables.set(table, t);
    }
    return t;
  }

  insert(table: string, doc: Record<string, unknown>, id?: string): string {
    if (this.failNextInsert === table) {
      this.failNextInsert = null;
      throw new Error(`injected failure: insert ${table}`);
    }
    const rowId = id ?? `${table}:${++this.seq}`;
    this.tableOf(table).set(rowId, { row: { ...doc, _id: rowId } as Row, version: 1 });
    return rowId;
  }

  get(id: string): Stored | null {
    for (const t of this.tables.values()) {
      const hit = t.get(id);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  patch(id: string, doc: Record<string, unknown>): void {
    const hit = this.get(id);
    if (hit === null) throw new Error(`fake patch: missing ${id}`);
    hit.row = { ...hit.row, ...doc };
    hit.version += 1;
  }

  rows(table: string): Stored[] {
    return [...this.tableOf(table).values()];
  }

  snapshot(): Map<string, Stored> {
    const out = new Map<string, Stored>();
    for (const t of this.tables.values()) {
      for (const [id, stored] of t) {
        out.set(id, { row: structuredClone(stored.row) as Row, version: stored.version });
      }
    }
    return out;
  }

  restore(snap: Map<string, Stored>): void {
    for (const t of this.tables.values()) t.clear();
    for (const [id, stored] of snap) {
      const table = id.split(":")[0];
      this.tableOf(table).set(id, {
        row: structuredClone(stored.row) as Row,
        version: stored.version,
      });
    }
  }
}

/* ── OCC-emulating ctx + runners ── */

class OccConflictError extends Error {}

function makeCtx(store: FakeStore, stale?: Map<string, Stored>): { db: unknown } {
  const readVersions = new Map<string, number>();

  const readRow = (id: string): Row | null => {
    const src = stale?.get(id) ?? store.get(id);
    if (src != null) readVersions.set(id, src.version);
    return src != null ? ({ ...src.row } as Row) : null;
  };

  const assertFresh = (): void => {
    for (const [id, version] of readVersions) {
      const live = store.get(id);
      if ((live?.version ?? -1) !== version) {
        throw new OccConflictError(`stale read: ${id}`);
      }
    }
  };

  const db = {
    get: async (id: string) => readRow(id),
    insert: async (table: string, doc: Record<string, unknown>) => {
      assertFresh();
      return store.insert(table, doc);
    },
    patch: async (id: string, doc: Record<string, unknown>) => {
      assertFresh();
      store.patch(id, doc);
      readVersions.set(String(id), store.get(String(id))?.version ?? -1);
    },
    query: () => ({
      withIndex: (
        _name: string,
        fn: (q: { eq: (field: string, value: unknown) => null }) => null,
      ) => {
        let captured: unknown;
        fn({ eq: (_field, value) => { captured = value; return null; } });
        return {
          collect: async () => {
            const source = stale ?? store.snapshot();
            const out: Row[] = [];
            for (const [id, stored] of source) {
              if (stored.row.auctionId === captured) {
                out.push({ ...stored.row } as Row);
                readVersions.set(id, stored.version);
              }
            }
            return out;
          },
        };
      },
    }),
  };
  return { db };
}

/** Run like Convex: on write-conflict, restart with fresh reads. */
async function runTx<T>(
  store: FakeStore,
  fn: (ctx: { db: unknown }) => Promise<T>,
  staleFirstAttempt?: Map<string, Stored>,
): Promise<T> {
  let stale = staleFirstAttempt;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn(makeCtx(store, stale));
    } catch (error) {
      if (error instanceof OccConflictError) {
        stale = undefined; // restart against committed state
        continue;
      }
      throw error;
    }
  }
  throw new Error("OCC retries exhausted");
}

/** Run inside an all-or-nothing transaction: any throw restores the store. */
async function runTxAtomic<T>(
  store: FakeStore,
  fn: (ctx: { db: unknown }) => Promise<T>,
): Promise<T> {
  const snap = store.snapshot();
  try {
    return await fn(makeCtx(store));
  } catch (error) {
    store.restore(snap);
    throw error;
  }
}

/* ── Seed helpers ── */

const OP_ID = "users:op" as unknown as Id<"users">;
const USER_ID = "users:u9" as unknown as Id<"users">;
const AUCTION_ID = "auctions:a1" as unknown as Id<"auctions">;
const AUCTION2_ID = "auctions:a2" as unknown as Id<"auctions">;

async function seedPrize(
  store: FakeStore,
  initialCount = 5,
): Promise<Id<"prizes">> {
  store.insert("users", { role: "operator" }, "users:op");
  store.insert("users", { role: "user" }, "users:u9");
  const result = await runTx(store, (ctx) =>
    createPrizeRow(ctx, {
      operatorUserId: OP_ID,
      draft: {
        title: "Test Prize",
        images: ["img-1"],
        fulfillmentMethod: "delivery",
        initialCount,
      },
    }),
  );
  if (!result.ok) throw new Error("seed failed");
  return result.prizeId;
}

/* ═══════════════ 1. Pure domain rules ═══════════════ */

describe("inventory pure rules", () => {
  test("evaluateReserve accepts valid quantities and computes the decrement", () => {
    expect(evaluateReserve({ availableCount: 5, quantity: 2 })).toEqual({
      ok: true,
      resultingCount: 3,
    });
    expect(evaluateReserve({ availableCount: 5, quantity: 5 })).toEqual({
      ok: true,
      resultingCount: 0,
    });
  });

  test("evaluateReserve rejects invalid quantities", () => {
    expect(evaluateReserve({ availableCount: 5, quantity: 0 }).ok).toBe(false);
    expect(evaluateReserve({ availableCount: 5, quantity: -1 }).ok).toBe(false);
    expect(evaluateReserve({ availableCount: 5, quantity: 1.5 }).ok).toBe(false);
    expect(evaluateReserve({ availableCount: 5, quantity: Number.NaN }).ok).toBe(false);
  });

  test("evaluateReserve rejects an unhealthy inventory line and shortfalls", () => {
    expect(evaluateReserve({ availableCount: -1, quantity: 1 })).toEqual({
      ok: false,
      reason: "invalid_inventory_state",
    });
    expect(evaluateReserve({ availableCount: 5, quantity: 6 })).toEqual({
      ok: false,
      reason: "insufficient_inventory",
    });
  });

  test("evaluatePrizeDraft validates operator input", () => {
    expect(
      evaluatePrizeDraft({
        title: "  ",
        images: [],
        fulfillmentMethod: "delivery",
        initialCount: 1,
      }).ok,
    ).toBe(false);
    expect(
      evaluatePrizeDraft({
        title: "x",
        images: "nope" as unknown as string[],
        fulfillmentMethod: "delivery",
        initialCount: 1,
      }).ok,
    ).toBe(false);
    expect(
      evaluatePrizeDraft({
        title: "x",
        images: [""],
        fulfillmentMethod: "delivery",
        initialCount: 1,
      }).ok,
    ).toBe(false);
    expect(
      evaluatePrizeDraft({
        title: "x",
        images: [],
        fulfillmentMethod: "teleport" as "delivery",
        initialCount: 1,
      }).ok,
    ).toBe(false);
    expect(
      evaluatePrizeDraft({
        title: "x",
        images: [],
        fulfillmentMethod: "delivery",
        initialCount: -1,
      }).ok,
    ).toBe(false);
    expect(
      evaluatePrizeDraft({
        title: "x",
        images: [],
        fulfillmentMethod: "delivery",
        initialCount: 2.5,
      }).ok,
    ).toBe(false);
  });

  test("release dispatch maps resolutions onto the frozen action/status pairs", () => {
    expect(evaluateReleaseDispatch("void")).toEqual({ ok: true, action: "RELEASE", status: "released" });
    expect(evaluateReleaseDispatch("no_winner")).toEqual({ ok: true, action: "RELEASE", status: "released" });
    expect(evaluateReleaseDispatch("cancel_before_open")).toEqual({
      ok: true,
      action: "CANCEL",
      status: "cancelled",
    });
    expect(evaluateReleaseDispatch("settlement").ok).toBe(false);
  });

  test("transition gate enforces the frozen state machine", () => {
    expect(
      evaluateInventoryTransition("reserved", "COMMIT", "settlement").ok,
    ).toBe(true);
    expect(
      evaluateInventoryTransition("reserved", "RELEASE", "void").ok,
    ).toBe(true);
    // RELEASE cannot carry the CANCEL-only resolution.
    expect(
      evaluateInventoryTransition("reserved", "RELEASE", "cancel_before_open"),
    ).toEqual({ ok: false, reason: "illegal_resolution" });
    // Terminal states accept nothing.
    expect(
      evaluateInventoryTransition("committed", "RELEASE", "void"),
    ).toEqual({ ok: false, reason: "illegal_reservation_status" });
    expect(
      evaluateInventoryTransition("released", "COMMIT", "settlement"),
    ).toEqual({ ok: false, reason: "illegal_reservation_status" });
  });

  test("reserve replay classification: replay, conflict, blocked", () => {
    const prizeId = "prizes:1" as unknown as Id<"prizes">;
    expect(
      classifyReserveReplay(
        { prizeId, quantity: 1, status: "reserved" },
        { prizeId, quantity: 1 },
      ),
    ).toEqual({ kind: "replay" });
    expect(
      classifyReserveReplay(
        { prizeId, quantity: 1, status: "reserved" },
        { prizeId, quantity: 2 },
      ),
    ).toEqual({ kind: "conflict" });
    expect(
      classifyReserveReplay(
        { prizeId, quantity: 1, status: "committed" },
        { prizeId, quantity: 1 },
      ),
    ).toEqual({ kind: "blocked" });
  });

  test("public prize projection exposes only the approved summary fields", () => {
    const projection = projectPublicPrize({
      title: "P",
      description: "D",
      images: ["a"],
      fulfillmentMethod: "pickup",
      // @ts-expect-error — simulates a raw row carrying internal fields
      availableCount: 5,
      createdAt: 1,
    });
    expect(Object.keys(projection).sort()).toEqual([
      "description",
      "fulfillmentMethod",
      "images",
      "title",
    ]);
    for (const key of Object.keys(projection)) {
      expect(isProhibitedField(key)).toBe(false);
    }
    expect("availableCount" in projection).toBe(false);
    expect("createdAt" in projection).toBe(false);
  });
});

/* ═══════════════ 2. Prize model ═══════════════ */

describe("prize model", () => {
  test("operator creates a prize with audited attribution", async () => {
    const store = new FakeStore();
    store.insert("users", { role: "operator" }, "users:op");

    const result = await runTx(store, (ctx) =>
      createPrizeRow(ctx, {
        operatorUserId: OP_ID,
        draft: {
          title: "Prize A",
          description: "Desc",
          images: ["img-1", "img-2"],
          fulfillmentMethod: "pickup",
          pickupLocationRef: "loc-1",
          initialCount: 3,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const prize = store.get(result.prizeId);
    expect(prize?.row.title).toBe("Prize A");
    expect(prize?.row.availableCount).toBe(3);
    expect(prize?.row.fulfillmentMethod).toBe("pickup");

    const audits = store.rows("auditEvents").map((s) => s.row);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("operator.action");
    expect(audits[0].actorRole).toBe("operator");
    expect(audits[0].actorId).toBe("users:op");
    expect(audits[0].entityId).toBe(result.prizeId);
  });

  test("non-operator and unknown actors fail closed with zero writes", async () => {
    const store = new FakeStore();
    store.insert("users", { role: "user" }, "users:u9");

    const refused = await runTx(store, (ctx) =>
      createPrizeRow(ctx, {
        operatorUserId: USER_ID,
        draft: { title: "X", images: [], fulfillmentMethod: "delivery", initialCount: 1 },
      }),
    );
    expect(refused).toEqual({ ok: false, reason: "not_authorized" });

    const dangling = await runTx(store, (ctx) =>
      createPrizeRow(ctx, {
        operatorUserId: "users:ghost" as unknown as Id<"users">,
        draft: { title: "X", images: [], fulfillmentMethod: "delivery", initialCount: 1 },
      }),
    );
    expect(dangling).toEqual({ ok: false, reason: "not_authorized" });

    expect(store.rows("prizes")).toHaveLength(0);
    expect(store.rows("auditEvents")).toHaveLength(0);
  });

  test("updates touch only permitted metadata — inventory is structurally immutable", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);

    const updated = await runTx(store, (ctx) =>
      updatePrizeRow(ctx, {
        operatorUserId: OP_ID,
        prizeId,
        patch: { title: "Renamed", description: "New desc" },
      }),
    );
    expect(updated.ok).toBe(true);
    expect(store.get(prizeId)?.row.title).toBe("Renamed");
    expect(store.get(prizeId)?.row.availableCount).toBe(5);

    // availableCount can NEVER be patched through the prize-update path.
    const inventoryAttack = await runTxAtomic(store, (ctx) =>
      updatePrizeRow(ctx, {
        operatorUserId: OP_ID,
        prizeId,
        patch: { availableCount: 9999 },
      }),
    );
    expect(inventoryAttack).toEqual({ ok: false, reason: "immutable_field" });
    expect(store.get(prizeId)?.row.availableCount).toBe(5);

    const createdAtAttack = await runTxAtomic(store, (ctx) =>
      updatePrizeRow(ctx, {
        operatorUserId: OP_ID,
        prizeId,
        patch: { createdAt: 0 },
      }),
    );
    expect(createdAtAttack).toEqual({ ok: false, reason: "immutable_field" });
    expect(store.get(prizeId)?.row.createdAt).not.toBe(0);
  });

  test("public projection strips operator-only fields", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 7);
    const prize = store.get(prizeId);
    if (prize === null) throw new Error("seed missing");

    const projection = publicPrizeProjection(
      prize.row as unknown as Parameters<typeof publicPrizeProjection>[0],
    );
    expect(Object.keys(projection).sort()).toEqual([
      "description",
      "fulfillmentMethod",
      "images",
      "title",
    ]);
    expect("availableCount" in projection).toBe(false);
    expect("deliveryCoverage" in projection).toBe(false);
    expect("pickupLocationRef" in projection).toBe(false);
    for (const key of Object.keys(projection)) {
      expect(isProhibitedField(key)).toBe(false);
    }
  });
});

/* ═══════════════ 3. RESERVE ═══════════════ */

describe("RESERVE", () => {
  test("holds inventory atomically: decrement + reservation + audit", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);

    const result = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 2,
      }),
    );
    expect(result).toEqual({
      ok: true,
      reservationId: expect.any(String),
      replayed: false,
      availableCount: 3,
    });
    if (!result.ok) return;

    expect(store.get(prizeId)?.row.availableCount).toBe(3);
    const reservation = store.get(result.reservationId);
    expect(reservation?.row).toMatchObject({
      prizeId,
      auctionId: AUCTION_ID,
      quantity: 2,
      status: "reserved",
    });

    const audits = store.rows("auditEvents").map((s) => s.row);
    const reserveAudit = audits.find((a) => a.action === "inventory.reserved");
    expect(reserveAudit).toBeDefined();
    expect(reserveAudit?.actorRole).toBe("operator");
    expect(reserveAudit?.actorId).toBe("users:op");
  });

  test("rejects invalid quantities, unknown prizes, and non-operators with zero writes", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);
    const before = store.snapshot();
    const auditsBefore = store.rows("auditEvents").length; // seed's prize.create audit

    for (const quantity of [0, -1, 1.5]) {
      const refused = await runTx(store, (ctx) =>
        reserveInventory(ctx, {
          operatorUserId: OP_ID,
          auctionId: AUCTION_ID,
          prizeId,
          quantity,
        }),
      );
      expect(refused).toEqual({ ok: false, reason: "invalid_quantity" });
    }

    const unknownPrize = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId: "prizes:ghost" as unknown as Id<"prizes">,
        quantity: 1,
      }),
    );
    expect(unknownPrize).toEqual({ ok: false, reason: "prize_not_found" });

    const notOperator = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: USER_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    expect(notOperator).toEqual({ ok: false, reason: "not_authorized" });

    // Zero partial effect: nothing was written anywhere.
    const after = store.snapshot();
    expect(after.get(prizeId)?.version).toBe(before.get(prizeId)?.version);
    expect(store.rows("inventoryReservations")).toHaveLength(0);
    expect(store.rows("auditEvents")).toHaveLength(auditsBefore);
  });

  test("refuses over-commitment: no negative inventory, zero partial effect", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 2);
    const auditsBefore = store.rows("auditEvents").length;

    const refused = await runTxAtomic(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 3,
      }),
    );
    expect(refused).toEqual({ ok: false, reason: "insufficient_inventory" });
    expect(store.get(prizeId)?.row.availableCount).toBe(2);
    expect(store.rows("inventoryReservations")).toHaveLength(0);
    expect(store.rows("auditEvents")).toHaveLength(auditsBefore);
  });

  test("identical re-RESERVE replays with zero effect", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);

    const first = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    if (!first.ok) throw new Error("first reserve failed");
    const auditsAfterFirst = store.rows("auditEvents").length;
    const versionAfterFirst = store.get(prizeId)?.version;

    const replay = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    expect(replay).toEqual({
      ok: true,
      reservationId: first.reservationId,
      replayed: true,
      availableCount: 4,
    });
    expect(store.get(prizeId)?.row.availableCount).toBe(4);
    expect(store.get(prizeId)?.version).toBe(versionAfterFirst);
    expect(store.rows("auditEvents")).toHaveLength(auditsAfterFirst);
  });

  test("different parameters for the same auction conflict", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);

    const first = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    if (!first.ok) throw new Error("first reserve failed");

    const conflict = await runTxAtomic(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 2,
      }),
    );
    expect(conflict).toEqual({ ok: false, reason: "reservation_conflict" });
    expect(store.get(prizeId)?.row.availableCount).toBe(4);
    expect(store.rows("inventoryReservations")).toHaveLength(1);
  });

  test("re-reserving after a terminal reservation is blocked", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);

    const reserved = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    if (!reserved.ok) throw new Error("reserve failed");

    await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId: reserved.reservationId,
        resolution: "cancel_before_open",
        operatorUserId: OP_ID,
      }),
    );

    const blocked = await runTxAtomic(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    expect(blocked).toEqual({ ok: false, reason: "reservation_conflict" });
  });

  test("concurrent last-unit race: one wins, the loser restarts and refuses", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 1);

    // Transaction B reads the pre-A snapshot (stale view: count still 1),
    // so its first attempt passes the guard — then loses the write race
    // (OCC conflict) and restarts against committed state.
    const stale = store.snapshot();

    const winner = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    expect(winner.ok).toBe(true);

    const loser = await runTx(
      store,
      (ctx) =>
        reserveInventory(ctx, {
          operatorUserId: OP_ID,
          auctionId: AUCTION2_ID,
          prizeId,
          quantity: 1,
        }),
      stale,
    );
    expect(loser).toEqual({ ok: false, reason: "insufficient_inventory" });

    // Invariants: exactly one reservation, count never negative.
    expect(store.get(prizeId)?.row.availableCount).toBe(0);
    expect(store.rows("inventoryReservations")).toHaveLength(1);
  });
});

/* ═══════════════ 4. COMMIT ═══════════════ */

describe("COMMIT", () => {
  async function seedReservation(store: FakeStore, initialCount = 5) {
    const prizeId = await seedPrize(store, initialCount);
    const reserved = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity: 1,
      }),
    );
    if (!reserved.ok) throw new Error("reserve failed");
    return { prizeId, reservationId: reserved.reservationId };
  }

  test("permanently consumes the reservation without restoring inventory", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store);

    const committed = await runTx(store, (ctx) =>
      commitReservation(ctx, { reservationId }),
    );
    expect(committed).toEqual({ ok: true, reservationId, replayed: false });

    const reservation = store.get(reservationId);
    expect(reservation?.row.status).toBe("committed");
    expect(reservation?.row.resolvedBy).toBe("settlement");
    expect(typeof reservation?.row.resolvedAt).toBe("number");
    // Permanently consumed — availableCount does NOT come back.
    expect(store.get(prizeId)?.row.availableCount).toBe(4);

    const audits = store.rows("auditEvents").map((s) => s.row);
    const commitAudit = audits.find((a) => a.action === "inventory.committed");
    expect(commitAudit).toBeDefined();
    expect(commitAudit?.actorRole).toBe("system");
  });

  test("duplicate COMMIT replays with zero effect", async () => {
    const store = new FakeStore();
    const { reservationId } = await seedReservation(store);

    await runTx(store, (ctx) => commitReservation(ctx, { reservationId }));
    const auditsAfterFirst = store.rows("auditEvents").length;
    const reservationVersion = store.get(reservationId)?.version;

    const replay = await runTx(store, (ctx) =>
      commitReservation(ctx, { reservationId }),
    );
    expect(replay).toEqual({ ok: true, reservationId, replayed: true });
    expect(store.get(reservationId)?.version).toBe(reservationVersion);
    expect(store.rows("auditEvents")).toHaveLength(auditsAfterFirst);
  });

  test("COMMIT over a released reservation refuses", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store);

    await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "void",
        operatorUserId: null,
      }),
    );

    const refused = await runTxAtomic(store, (ctx) =>
      commitReservation(ctx, { reservationId }),
    );
    expect(refused).toEqual({ ok: false, reason: "terminal_state" });
    expect(store.get(reservationId)?.row.status).toBe("released");
    expect(store.get(prizeId)?.row.availableCount).toBe(5);
  });

  test("COMMIT vs RELEASE race: the loser restarts into terminal_state, no double effect", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store, 5);
    const stale = store.snapshot(); // pre-resolution view: status "reserved"

    // Winner: COMMIT consumes the reservation.
    const winner = await runTx(store, (ctx) =>
      commitReservation(ctx, { reservationId }),
    );
    expect(winner.ok).toBe(true);

    // Loser: RELEASE read the stale `reserved` state, passed its guard,
    // then lost the write race (OCC conflict) and restarted — landing on
    // terminal_state with the inventory untouched.
    const loser = await runTx(
      store,
      (ctx) =>
        resolveReservation(ctx, {
          reservationId,
          resolution: "void",
          operatorUserId: null,
        }),
      stale,
    );
    expect(loser).toEqual({ ok: false, reason: "terminal_state" });

    // Exactly one resolution; inventory NOT restored by the losing release.
    expect(store.get(reservationId)?.row.status).toBe("committed");
    expect(store.get(prizeId)?.row.availableCount).toBe(4);
    const releaseAudits = store
      .rows("auditEvents")
      .map((s) => s.row)
      .filter((a) => a.action === "inventory.released");
    expect(releaseAudits).toHaveLength(0);
  });
});

/* ═══════════════ 5. RELEASE ═══════════════ */

describe("RELEASE", () => {
  async function seedReservation(store: FakeStore, initialCount = 5, quantity = 2) {
    const prizeId = await seedPrize(store, initialCount);
    const reserved = await runTx(store, (ctx) =>
      reserveInventory(ctx, {
        operatorUserId: OP_ID,
        auctionId: AUCTION_ID,
        prizeId,
        quantity,
      }),
    );
    if (!reserved.ok) throw new Error("reserve failed");
    return { prizeId, reservationId: reserved.reservationId, quantity };
  }

  test("restores inventory exactly once and records the void resolution", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId, quantity } = await seedReservation(store, 5, 2);

    const released = await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "void",
        operatorUserId: null,
      }),
    );
    expect(released).toEqual({
      ok: true,
      reservationId,
      status: "released",
      replayed: false,
      availableCount: 5,
    });
    expect(store.get(prizeId)?.row.availableCount).toBe(5);

    const reservation = store.get(reservationId);
    expect(reservation?.row.status).toBe("released");
    expect(reservation?.row.resolvedBy).toBe("void");
    // History preserved: original fields intact, row never deleted.
    expect(reservation?.row.prizeId).toBe(prizeId);
    expect(reservation?.row.quantity).toBe(quantity);
    expect(typeof reservation?.row.reservedAt).toBe("number");

    const audits = store.rows("auditEvents").map((s) => s.row);
    const releaseAudit = audits.find((a) => a.action === "inventory.released");
    expect(releaseAudit).toBeDefined();
    expect(releaseAudit?.actorRole).toBe("system");
  });

  test("cancel_before_open maps to the cancelled status with operator attribution", async () => {
    const store = new FakeStore();
    const { reservationId } = await seedReservation(store, 5, 1);

    const cancelled = await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "cancel_before_open",
        operatorUserId: OP_ID,
      }),
    );
    expect(cancelled).toEqual({
      ok: true,
      reservationId,
      status: "cancelled",
      replayed: false,
      availableCount: 5,
    });
    const audits = store.rows("auditEvents").map((s) => s.row);
    const releaseAudit = audits.find((a) => a.action === "inventory.released");
    expect(releaseAudit?.actorRole).toBe("operator");
    expect(releaseAudit?.actorId).toBe("users:op");
    expect(releaseAudit?.meta).toMatchObject({ resolution: "cancel_before_open" });
  });

  test("terminal NO_WINNER release via system actor", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store, 5, 1);

    const released = await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "no_winner",
        operatorUserId: null,
      }),
    );
    expect(released.ok).toBe(true);
    expect(store.get(prizeId)?.row.availableCount).toBe(5);
    const audits = store.rows("auditEvents").map((s) => s.row);
    const releaseAudit = audits.find((a) => a.action === "inventory.released");
    expect(releaseAudit?.actorRole).toBe("system");
    expect(releaseAudit?.actorId).toBeNull();
  });

  test("duplicate RELEASE replays with zero restoration", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store, 5, 2);

    await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "void",
        operatorUserId: null,
      }),
    );
    const auditsAfterFirst = store.rows("auditEvents").length;
    const prizeVersion = store.get(prizeId)?.version;

    const replay = await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "void",
        operatorUserId: null,
      }),
    );
    expect(replay).toEqual({
      ok: true,
      reservationId,
      status: "released",
      replayed: true,
      availableCount: 5,
    });
    expect(store.get(prizeId)?.row.availableCount).toBe(5);
    expect(store.get(prizeId)?.version).toBe(prizeVersion);
    expect(store.rows("auditEvents")).toHaveLength(auditsAfterFirst);
  });

  test("conflicting resolution over a terminal reservation refuses", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store, 5, 2);

    await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "void",
        operatorUserId: null,
      }),
    );

    const refused = await runTxAtomic(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "no_winner",
        operatorUserId: null,
      }),
    );
    expect(refused).toEqual({ ok: false, reason: "terminal_state" });
    // Inventory restored exactly once, never twice.
    expect(store.get(prizeId)?.row.availableCount).toBe(5);
    expect(store.get(reservationId)?.row.resolvedBy).toBe("void");
  });

  test("RELEASE cannot overshoot the original inventory", async () => {
    const store = new FakeStore();
    const { prizeId, reservationId } = await seedReservation(store, 3, 2);

    await runTx(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "void",
        operatorUserId: null,
      }),
    );
    // 3 - 2 + 2 = 3: exactly the original line, never above it.
    expect(store.get(prizeId)?.row.availableCount).toBe(3);
  });

  test("non-operator attribution on an operator-only resolution fails closed", async () => {
    const store = new FakeStore();
    const { reservationId } = await seedReservation(store, 5, 1);

    const refused = await runTxAtomic(store, (ctx) =>
      resolveReservation(ctx, {
        reservationId,
        resolution: "cancel_before_open",
        operatorUserId: USER_ID,
      }),
    );
    expect(refused).toEqual({ ok: false, reason: "not_authorized" });
    expect(store.get(reservationId)?.row.status).toBe("reserved");
  });
});

/* ═══════════════ 6. Atomicity ═══════════════ */

describe("inventory atomicity", () => {
  test("mid-transaction failure leaves zero partial state", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store, 5);
    const before = store.snapshot();
    const auditsBefore = store.rows("auditEvents").length;

    store.failNextInsert = "inventoryReservations"; // fails AFTER the line decrement
    let threw = false;
    try {
      await runTxAtomic(store, (ctx) =>
        reserveInventory(ctx, {
          operatorUserId: OP_ID,
          auctionId: AUCTION_ID,
          prizeId,
          quantity: 1,
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Transaction aborted → the decrement is rolled back with it.
    expect(store.get(prizeId)?.row.availableCount).toBe(5);
    expect(store.rows("inventoryReservations")).toHaveLength(0);
    expect(store.rows("auditEvents")).toHaveLength(auditsBefore);
    const after = store.snapshot();
    expect(after.get(prizeId)?.version).toBe(before.get(prizeId)?.version);
  });
});
