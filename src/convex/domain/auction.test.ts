/**
 * LUBA V1 — auction foundation/lifecycle tests (Phase G).
 *
 * Harness (same OCC-emulating semantics as the Phase F/D fakes):
 *  - versioned in-memory store; rows never deleted;
 *  - reads record row versions; every write re-validates and throws
 *    `OccConflictError` on a stale read — Convex OCC's abort-then-retry
 *    (`runTx` restarts with fresh reads);
 *  - `runTxAtomic` deep-snapshots and restores on ANY throw — Convex's
 *    all-or-nothing transaction model;
 *  - index emulation matches `auctionId` (by_auction) or `status`
 *    (by_status_closeAt) equality captures.
 */
import { describe, expect, test } from "bun:test";
import type { Id } from "../_generated/dataModel";

import {
  evaluateAuctionConfig,
  evaluateAntiSnipeExtension,
  evaluateCloseEligibility,
  evaluateOpenEligibility,
  evaluatePublishEligibility,
  projectPublicAuctionDetail,
  projectPublicAuctionSummary,
} from "./auctions";
import { createAuctionRow, updateAuctionConfigRow } from "../auction/create";
import {
  applyAntiSnipeExtension,
  closeAuction,
  openAuction,
  publishAuction,
  sweepCloseExpired,
  sweepOpenScheduled,
} from "../auction/lifecycle";
import { isProhibitedField } from "../guards/projections";

/* ── Fake store ── */

type Row = Record<string, unknown> & { _id: string };
type Stored = { row: Row; version: number };

class FakeStore {
  private tables = new Map<string, Map<string, Stored>>();
  private seq = 0;
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
        let field = "";
        fn({ eq: (f, value) => { field = f; captured = value; return null; } });
        return {
          collect: async () => {
            const source = stale ?? store.snapshot();
            const out: Row[] = [];
            for (const [id, stored] of source) {
              if (captured !== undefined && stored.row[field] === captured) {
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
        stale = undefined;
        continue;
      }
      throw error;
    }
  }
  throw new Error("OCC retries exhausted");
}

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

const BASE = 1_700_000_000_000;
const T0 = BASE;
const T1 = BASE + 60_000;

async function seedPrize(store: FakeStore): Promise<Id<"prizes">> {
  store.insert("users", { role: "operator" }, "users:op");
  store.insert("users", { role: "user" }, "users:u9");
  const { createPrizeRow } = await import("../inventory/prizes");
  const result = await runTx(store, (ctx) =>
    createPrizeRow(ctx, {
      operatorUserId: OP_ID,
      draft: {
        title: "Prize",
        images: ["img-1"],
        fulfillmentMethod: "delivery",
        initialCount: 5,
      },
    }),
  );
  if (!result.ok) throw new Error("seed failed");
  return result.prizeId;
}

function validConfig(prizeId: Id<"prizes">, overrides: Record<string, unknown> = {}) {
  return {
    code: "LUB-0001",
    title: "Flagship auction",
    prizeId,
    closeAt: T1,
    fulfillmentMethod: "delivery" as const,
    ...overrides,
  };
}

async function seedAuction(
  store: FakeStore,
  overrides: Record<string, unknown> = {},
): Promise<Extract<Awaited<ReturnType<typeof createAuctionRow>>, { ok: true }>> {
  const prizeId = await seedPrize(store);
  const result = await runTx(store, (ctx) =>
    createAuctionRow(ctx, {
      operatorUserId: OP_ID,
      config: validConfig(prizeId, overrides),
      now: T0,
    }),
  );
  if (!result.ok) throw new Error(`seed auction failed: ${result.reason}`);
  return result;
}

function auctionRow(store: FakeStore, id: string): Row {
  const hit = store.get(id);
  if (hit === null) throw new Error("missing auction");
  return hit.row;
}

function reservationRow(store: FakeStore, auctionId: string): Row | null {
  for (const stored of store.rows("inventoryReservations")) {
    if (stored.row.auctionId === auctionId) return stored.row;
  }
  return null;
}

function countAudit(store: FakeStore, action: string, baseline: number): number {
  return (
    store.rows("auditEvents").filter((s) => s.row.action === action).length - baseline
  );
}

function auditBaseline(store: FakeStore): number {
  return store.rows("auditEvents").length;
}

/* ═══════════════ 1. Pure configuration rules ═══════════════ */

describe("auction pure configuration", () => {
  test("evaluateAuctionConfig accepts a valid future close and normalizes input", () => {
    const evaluation = evaluateAuctionConfig(
      validConfig("prizes:p1" as unknown as Id<"prizes">, { code: " LUB-0002 ", title: " T " }),
      T0,
    );
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.row.code).toBe("LUB-0002");
    expect(evaluation.row.title).toBe("T");
  });

  test("evaluateAuctionConfig rejects structurally invalid configuration", () => {
    const prizeId = "prizes:p1" as unknown as Id<"prizes">;
    expect(evaluateAuctionConfig(validConfig(prizeId, { code: "" }), T0).ok).toBe(false);
    expect(evaluateAuctionConfig(validConfig(prizeId, { title: "  " }), T0).ok).toBe(false);
    // Close time in the past — server clock authority (client spoof rejected).
    expect(evaluateAuctionConfig(validConfig(prizeId, { closeAt: T0 - 1 }), T0).ok).toBe(false);
    // startAt not strictly before closeAt.
    expect(
      evaluateAuctionConfig(validConfig(prizeId, { startAt: T1 }), T0).ok,
    ).toBe(false);
    // Bounds inverted.
    expect(
      evaluateAuctionConfig(validConfig(prizeId, { minBidSantim: 500, maxBidSantim: 400 }), T0)
        .ok,
    ).toBe(false);
    // Non-integer / non-positive fee.
    expect(evaluateAuctionConfig(validConfig(prizeId, { feeSantim: 1.5 }), T0).ok).toBe(false);
    expect(evaluateAuctionConfig(validConfig(prizeId, { feeSantim: 0 }), T0).ok).toBe(false);
    // Partial anti-snipe config (all three must be set together).
    expect(
      evaluateAuctionConfig(validConfig(prizeId, { antiSnipeWindowMs: 10_000 }), T0).ok,
    ).toBe(false);
  });

  test("evaluateAuctionConfig accepts a complete anti-snipe triple (infrastructure ready, values OPEN)", () => {
    const evaluation = evaluateAuctionConfig(
      validConfig("prizes:p1" as unknown as Id<"prizes">, {
        antiSnipeWindowMs: 30_000,
        antiSnipeExtendMs: 15_000,
        antiSnipeMaxExtensions: 2,
      }),
      T0,
    );
    expect(evaluation.ok).toBe(true);
  });

  test("projectPublicAuctionSummary/Detail expose no blind-bidding or operator fields", () => {
    const summary = projectPublicAuctionSummary({
      auction: {
        code: "LUB-0001",
        title: "T",
        status: "OPEN",
        startAt: T0,
        closeAt: T1,
        fulfillmentMethod: "delivery",
        feeSantim: 100,
      },
      prize: { title: "Prize", images: ["img-1"] },
    });
    expect(Object.keys(summary).sort()).toEqual(
      ["closeAt", "code", "feeSantim", "fulfillmentMethod", "prize", "startAt", "status", "title"],
    );

    const detail = projectPublicAuctionDetail({
      auction: {
        code: "LUB-0001",
        title: "T",
        description: "D",
        status: "OPEN",
        startAt: T0,
        closeAt: T1,
        fulfillmentMethod: "delivery",
        feeSantim: 100,
        minBidSantim: 100,
        maxBidSantim: 5000,
      },
      prize: { title: "Prize", images: ["img-1"] },
    });
    const keys = Object.keys(detail);
    // Prohibited blind-bidding/operator fields are absent AND marked
    // structurally prohibited by the Phase B guard.
    for (const prohibited of [
      "winnerUserId",
      "currentWinner",
      "lowestUniqueSantim",
      "bidDistribution",
      "uniqueBidCount",
      "antiSnipeWindowMs",
      "pickupDetails",
      "blindMode",
    ]) {
      expect(keys).not.toContain(prohibited);
    }
    expect(isProhibitedField("lowestUniqueSantim")).toBe(true);
    expect(detail.minBidSantim).toBe(100);
    expect(detail.maxBidSantim).toBe(5000);
  });
});

/* ═══════════════ 2. Creation / configuration (operator-only) ═══════════════ */

describe("auction creation", () => {
  test("creates a DRAFT auction with its inventory reservation in one transaction", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    const row = auctionRow(store, seed.auctionId);
    expect(row.status).toBe("DRAFT");
    expect(row.blindMode).toBe(true);
    expect(row.extensionCount).toBe(0);
    expect(row.createdBy).toBe(OP_ID);
    const reservation = reservationRow(store, String(seed.auctionId));
    expect(reservation).not.toBeNull();
    expect(reservation?.status).toBe("reserved");
    expect(reservation?.quantity).toBe(1);
  });

  test("refuses non-operator creation with zero writes", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store);
    const baseline = auditBaseline(store);
    const result = await runTxAtomic(store, (ctx) =>
      createAuctionRow(ctx, {
        operatorUserId: USER_ID,
        config: validConfig(prizeId),
        now: T0,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_authorized");
    expect(store.rows("auctions").length).toBe(0);
    expect(store.rows("inventoryReservations").length).toBe(0);
    expect(countAudit(store, "operator.action", baseline)).toBe(0);
  });

  test("refuses invalid configuration before any write (no reservation leak)", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store);
    const before = store.get(String(prizeId))?.row.availableCount;
    const result = await runTxAtomic(store, (ctx) =>
      createAuctionRow(ctx, {
        operatorUserId: OP_ID,
        config: validConfig(prizeId, { closeAt: T0 - 5 }),
        now: T0,
      }),
    );
    expect(result.ok).toBe(false);
    expect(store.rows("auctions").length).toBe(0);
    expect(store.rows("inventoryReservations").length).toBe(0);
    // The prize line is untouched — nothing was reserved for a refused config.
    expect(store.get(String(prizeId))?.row.availableCount).toBe(before);
  });

  test("configuration updates are DRAFT-only; published auctions are frozen", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    const publish = await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    expect(publish.ok).toBe(true);

    const update = await updateAuctionConfigRow(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      patch: { title: "Changed" },
      now: T0,
    });
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.reason).toBe("config_frozen");
    expect(auctionRow(store, String(seed.auctionId)).title).toBe("Flagship auction");
  });

  test("valid DRAFT reconfiguration persists the merged patch", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    const update = await updateAuctionConfigRow(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      patch: { title: "Renamed", feeSantim: 250 },
      now: T0,
    });
    expect(update.ok).toBe(true);
    const row = auctionRow(store, String(seed.auctionId));
    expect(row.title).toBe("Renamed");
    expect(row.feeSantim).toBe(250);
  });
});

/* __APPEND_MARKER__ */
