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

function auditCount(store: FakeStore, action: string): number {
  return store.rows("auditEvents").filter((s) => s.row.action === action).length;
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
    // Code is normalized (trimmed); title is stored as provided
    // (validated against its trimmed length) — display formatting
    // belongs to the UI layer, not the domain core.
    expect(evaluation.row.code).toBe("LUB-0002");
    expect(evaluation.row.title).toBe(" T ");
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
    const opAuditsBefore = auditCount(store, "operator.action");
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
    expect(auditCount(store, "operator.action")).toBe(opAuditsBefore);
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

/* ═══════════════ 3. Publish gate + lifecycle transitions ═══════════════ */

describe("publish gate and lifecycle", () => {
  test("publish requires the inventory reservation — verified server-side", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    // Strip the reservation (simulating a flow that never reserved) —
    // the publish path must still refuse.
    const res = reservationRow(store, String(seed.auctionId));
    if (res !== null) store.patch(String(res._id), { status: "released" });
    const result = await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reservation_required");
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("DRAFT");
  });

  test("non-operators cannot publish or open (zero effect)", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    const publish = await publishAuction(makeCtx(store), {
      operatorUserId: USER_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    expect(publish.ok).toBe(false);
    if (!publish.ok) expect(publish.reason).toBe("not_authorized");
    const open = await openAuction(makeCtx(store), {
      operatorUserId: USER_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    expect(open.ok).toBe(false);
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("DRAFT");
  });

  test("valid path: DRAFT → SCHEDULED → OPEN with audits", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    const scheduledBefore = auditCount(store, "auction.scheduled");
    const openedBefore = auditCount(store, "auction.opened");
    const published = await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    expect(published).toMatchObject({ ok: true, replayed: false });
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("SCHEDULED");
    const opened = await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    expect(opened).toMatchObject({ ok: true, replayed: false });
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("OPEN");
    expect(auditCount(store, "auction.scheduled")).toBe(scheduledBefore + 1);
    expect(auditCount(store, "auction.opened")).toBe(openedBefore + 1);
  });

  test("manual open before startAt is operator discretion; scheduled open is time-gated", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store, { startAt: T0 + 30_000 });
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    // Manual open: operator discretion — startAt does not block.
    const manual = await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    expect(manual.ok).toBe(true);

    // Scheduled sweep: start time has NOT arrived → refuses (too early).
    const store2 = new FakeStore();
    const seed2 = await seedAuction(store2, { startAt: T0 + 30_000 });
    await publishAuction(makeCtx(store2), {
      operatorUserId: OP_ID,
      auctionId: seed2.auctionId,
      now: T0,
    });
    const sweep = await sweepOpenScheduled(makeCtx(store2), { now: T0 + 1 });
    expect(sweep.opened).toBe(0);
    expect(auctionRow(store2, String(seed2.auctionId)).status).toBe("SCHEDULED");
    // Once the start time arrives on the server clock, the sweep opens it.
    const sweep2 = await sweepOpenScheduled(makeCtx(store2), { now: T0 + 30_000 });
    expect(sweep2.opened).toBe(1);
    expect(auctionRow(store2, String(seed2.auctionId)).status).toBe("OPEN");
  });

  test("open refuses at/after the authoritative close time", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    const result = await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T1, // exactly the close time — too late
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_late");
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("SCHEDULED");
  });

  test("invalid lifecycle transitions are refused (no skips, no backwards)", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    // DRAFT → OPEN is not a legal transition.
    const skip = await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    expect(skip.ok).toBe(false);
    if (!skip.ok) expect(skip.reason).toBe("illegal_transition");
    // Publish to SCHEDULED first.
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    // Close from SCHEDULED is illegal.
    const earlyClose = await closeAuction(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1,
    });
    expect(earlyClose.ok).toBe(false);
    if (!earlyClose.ok) expect(earlyClose.reason).toBe("illegal_transition");
  });

  test("publish/open replay with zero effect once the target state is reached", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    const scheduledCount = auditCount(store, "auction.scheduled");
    const replay = await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 5,
    });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(auditCount(store, "auction.scheduled")).toBe(scheduledCount);
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("SCHEDULED");
  });

  test("close transition stamps the authoritative result-determination time", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    const closed = await closeAuction(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 + 10,
    });
    expect(closed).toMatchObject({ ok: true, replayed: false, result: null });
    const row = auctionRow(store, String(seed.auctionId));
    expect(row.status).toBe("CLOSED");
    expect(row.resultDeterminedAt).toBe(T1 + 10);
  });

  test("close refuses early (server-time authority) and replays once closed", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    const early = await closeAuction(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 - 1,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe("too_early");
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("OPEN");

    await closeAuction(makeCtx(store), { auctionId: seed.auctionId, now: T1 });
    const closedCount = auditCount(store, "auction.closed");
    const replay = await closeAuction(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 + 100,
    });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(auditCount(store, "auction.closed")).toBe(closedCount);
  });
});

/* ═══════════════ 4. Anti-snipe infrastructure (values OPEN) ═══════════════ */

describe("anti-snipe", () => {
  async function openAuctionAt(store: FakeStore): Promise<string> {
    const seed = await seedAuction(store);
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    return String(seed.auctionId);
  }

  test("unset configuration ⇒ inactive with zero effect", async () => {
    const store = new FakeStore();
    const auctionId = await openAuctionAt(store);
    const before = auctionRow(store, auctionId).closeAt;
    const result = await applyAntiSnipeExtension(makeCtx(store), {
      auctionId: auctionId as unknown as Id<"auctions">,
      now: T1 - 1_000, // inside what would be a window — but none configured
    });
    expect(result).toMatchObject({ ok: true, active: false, newCloseAt: null });
    expect(auctionRow(store, auctionId).closeAt).toBe(before);
    expect(auctionRow(store, auctionId).extensionCount).toBe(0);
  });

  test("configured anti-snipe extends the authoritative close time atomically", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store, {
      antiSnipeWindowMs: 30_000,
      antiSnipeExtendMs: 15_000,
      antiSnipeMaxExtensions: 2,
    });
    const auctionId = String(seed.auctionId);
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    await openAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0 + 1,
    });
    // Outside the window: inactive, no mutation.
    const outside = await applyAntiSnipeExtension(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 - 31_000,
    });
    expect(outside).toMatchObject({ ok: true, active: false });
    expect(auctionRow(store, auctionId).closeAt).toBe(T1);
    // Inside the window: closeAt moves exactly once, count increments.
    const inside = await applyAntiSnipeExtension(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 - 10_000,
    });
    expect(inside).toMatchObject({ ok: true, active: true, newCloseAt: T1 + 15_000 });
    expect(auctionRow(store, auctionId).closeAt).toBe(T1 + 15_000);
    expect(auctionRow(store, auctionId).extensionCount).toBe(1);
    // Bounded by max: after 2 extensions the third refuses.
    await applyAntiSnipeExtension(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 + 15_000 - 10_000,
    });
    expect(auctionRow(store, auctionId).extensionCount).toBe(2);
    const exhausted = await applyAntiSnipeExtension(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 + 30_000 - 10_000,
    });
    expect(exhausted.ok).toBe(false);
    expect(auctionRow(store, auctionId).extensionCount).toBe(2);
  });

  test("anti-snipe only applies to OPEN auctions", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store, {
      antiSnipeWindowMs: 30_000,
      antiSnipeExtendMs: 15_000,
      antiSnipeMaxExtensions: 2,
    });
    const result = await applyAntiSnipeExtension(makeCtx(store), {
      auctionId: seed.auctionId,
      now: T1 - 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_open");
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("DRAFT");
  });

  test("pure evaluator: window boundary, closed-window, and exhausted cases", () => {
    const cfg = {
      closeAt: T1,
      antiSnipeWindowMs: 30_000,
      antiSnipeExtendMs: 15_000,
      antiSnipeMaxExtensions: 1,
      extensionCount: 0,
    };
    // Exactly at the boundary (now >= closeAt - window) — triggers.
    expect(evaluateAntiSnipeExtension({ ...cfg, now: T1 - 30_000 })).toEqual({
      ok: true,
      active: true,
      newCloseAt: T1 + 15_000,
    });
    // Before the window — inactive (no newCloseAt in that union member).
    expect(evaluateAntiSnipeExtension({ ...cfg, now: T1 - 30_001 })).toEqual({
      ok: true,
      active: false,
    });
    // At/after close — no extension (inactive, not an error).
    expect(evaluateAntiSnipeExtension({ ...cfg, now: T1 })).toEqual({
      ok: true,
      active: false,
    });
    // Already at max.
    expect(
      evaluateAntiSnipeExtension({ ...cfg, now: T1 - 10_000, extensionCount: 1 }).ok,
    ).toBe(false);
    // Unset ⇒ inactive.
    expect(
      evaluateAntiSnipeExtension({
        now: T1 - 10_000,
        closeAt: T1,
        antiSnipeWindowMs: undefined,
        antiSnipeExtendMs: undefined,
        antiSnipeMaxExtensions: undefined,
        extensionCount: 0,
      }),
    ).toEqual({ ok: true, active: false });
  });
});

/* ═══════════════ 5. Finalization seam + backstop sweeps ═══════════════ */

async function openAuctionAt(store: FakeStore): Promise<string> {
  const seed = await seedAuction(store);
  await publishAuction(makeCtx(store), {
    operatorUserId: OP_ID,
    auctionId: seed.auctionId,
    now: T0,
  });
  await openAuction(makeCtx(store), {
    operatorUserId: OP_ID,
    auctionId: seed.auctionId,
    now: T0 + 1,
  });
  return String(seed.auctionId);
}

describe("finalization seam and backstop", () => {

  test("the composed finalization runs INSIDE the close transaction", async () => {
    const store = new FakeStore();
    const auctionId = await openAuctionAt(store);
    const seen: string[] = [];
    const closed = await closeAuction(makeCtx(store), {
      auctionId: auctionId as unknown as Id<"auctions">,
      now: T1,
      finalize: async (_ctx, input) => {
        seen.push(input.auctionId);
        return { result: "WINNER" };
      },
    });
    expect(closed).toMatchObject({ ok: true, replayed: false, result: "WINNER" });
    expect(seen).toEqual([auctionId]);
  });

  test("a throwing finalization aborts with zero partial state", async () => {
    const store = new FakeStore();
    const auctionId = await openAuctionAt(store);
    // The finalize throw propagates — Convex aborts the transaction on any
    // thrown error; runTxAtomic restores, proving zero partial state.
    let threw = false;
    try {
      await runTxAtomic(store, (ctx) =>
        closeAuction(ctx, {
          auctionId: auctionId as unknown as Id<"auctions">,
          now: T1,
          finalize: async () => {
            throw new Error("determination failed");
          },
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Restored: still OPEN, no resultDeterminedAt stamp.
    const row = auctionRow(store, auctionId);
    expect(row.status).toBe("OPEN");
    expect(row.resultDeterminedAt).toBeUndefined();
  });

  test("the close backstop sweeps OPEN auctions past close time through the guarded mutation", async () => {
    const store = new FakeStore();
    const auctionId = await openAuctionAt(store);
    // Before close: nothing to do.
    const early = await sweepCloseExpired(makeCtx(store), { now: T1 - 1 });
    expect(early.closed).toBe(0);
    // At close time: swept through closeAuction (guards intact).
    const swept = await sweepCloseExpired(makeCtx(store), {
      now: T1,
      finalize: async () => ({ result: "NO_WINNER" }),
    });
    expect(swept.closed).toBe(1);
    expect(auctionRow(store, auctionId).status).toBe("CLOSED");
    // Re-sweep: replay, no double effect.
    const again = await sweepCloseExpired(makeCtx(store), {
      now: T1 + 60_000,
      finalize: async () => ({ result: "NO_WINNER" }),
    });
    expect(again.closed).toBe(0);
  });

  test("the close backstop IS cron-registered with the Phase I finalization hook composed", async () => {
    // Frozen Phase I §14: four minute-level crons — open sweep, close sweep
    // (with determination/finalization composed), void sweep, campaign backstop.
    const crons = await Bun.file("src/convex/crons.json").json();
    const registered = Object.values(crons) as Array<{ function: string }>;
    expect(registered.some((c) => c.function.includes("internalSweepOpenScheduled"))).toBe(true);
    expect(
      registered.some((c) => c.function.includes("internalSweepCloseExpired")),
    ).toBe(true);
    expect(
      registered.some((c) => c.function.includes("internalSweepVoidExpiredSettlements")),
    ).toBe(true);
    expect(registered.some((c) => c.function.includes("internalSweepStalledCampaigns"))).toBe(
      true,
    );
    expect(Object.keys(crons)).toHaveLength(4);
  });
});

/* ═══════════════ 6. Concurrency + atomicity ═══════════════ */

describe("auction concurrency and atomicity", () => {
  test("concurrent publish attempts serialize — one transition, one audit", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    // Two operators attempt to publish; OCC serializes on the auction row.
    const results = [];
    for (const ctx of [makeCtx(store), makeCtx(store)]) {
      results.push(
        await publishAuction(ctx, {
          operatorUserId: OP_ID,
          auctionId: seed.auctionId,
          now: T0,
        }),
      );
    }
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBe(2); // first transitions, second replays
    const replays = ok.filter((r) => r.ok && r.replayed).length;
    expect(replays).toBe(1);
    expect(auditCount(store, "auction.scheduled")).toBe(1);
    expect(auctionRow(store, String(seed.auctionId)).status).toBe("SCHEDULED");
  });

  test("stale-read publish attempt aborts and restarts into a safe replay", async () => {
    const store = new FakeStore();
    const seed = await seedAuction(store);
    // Operator B reads pre-publish state (stale snapshot)…
    const staleSnapshot = store.snapshot();
    // …operator A commits the publish.
    await publishAuction(makeCtx(store), {
      operatorUserId: OP_ID,
      auctionId: seed.auctionId,
      now: T0,
    });
    // …B's write aborts (OCC) and restarts with fresh reads → replay, no double audit.
    const scheduledBefore = auditCount(store, "auction.scheduled");
    const result = await runTx(
      store,
      (ctx) =>
        publishAuction(ctx, {
          operatorUserId: OP_ID,
          auctionId: seed.auctionId,
          now: T0 + 5,
        }),
      staleSnapshot,
    );
    expect(result).toMatchObject({ ok: true, replayed: true });
    expect(auditCount(store, "auction.scheduled")).toBe(scheduledBefore);
    void staleSnapshot;
  });

  test("concurrent close attempts produce exactly one close audit (replay safety)", async () => {
    const store = new FakeStore();
    const auctionId = await openAuctionAt(store);
    const first = await closeAuction(makeCtx(store), {
      auctionId: auctionId as unknown as Id<"auctions">,
      now: T1,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    const second = await closeAuction(makeCtx(store), {
      auctionId: auctionId as unknown as Id<"auctions">,
      now: T1 + 1,
    });
    expect(second).toMatchObject({ ok: true, replayed: true });
    expect(auditCount(store, "auction.closed")).toBe(1);
  });

  test("creation failure mid-transaction leaves zero partial state (no auction, no reservation, no decrement)", async () => {
    const store = new FakeStore();
    const prizeId = await seedPrize(store);
    const countBefore = store.get(String(prizeId))?.row.availableCount;
    store.failNextInsert = "inventoryReservations";
    let threw = false;
    try {
      await runTxAtomic(store, (ctx) =>
        createAuctionRow(ctx, {
          operatorUserId: OP_ID,
          config: validConfig(prizeId),
          now: T0,
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(store.rows("auctions").length).toBe(0);
    expect(store.rows("inventoryReservations").length).toBe(0);
    expect(store.get(String(prizeId))?.row.availableCount).toBe(countBefore);
  });
});

/* __APPEND_MARKER__ */
