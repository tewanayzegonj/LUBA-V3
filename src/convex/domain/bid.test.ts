/**
 * LUBA V1 — bidding engine tests (Phase H).
 *
 * The full-store fake extends the Phase E deposit-test store with the
 * tables the bid path touches (bids, auctions, users) and a provenance
 * by_user collect. OCC rollback is emulated by snapshot/restore around a
 * caught mid-transaction throw — a thrown Convex transaction removes ALL
 * of its writes.
 */
import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";
import { submitBid, projectOwnBids } from "../financial/bids";
import { transactionBalance } from "./reconciliation";
import { evaluateBidTimeWindow, evaluateBidPolicy } from "./bids";

/* ── Full-store fake ── */

const BIDDER = "users:b1" as Id<"users">;
const OTHER = "users:b2" as Id<"users">;
const AUCTION = "auctions:a1" as Id<"auctions">;
const NOW = 1_700_000_000_000;
const CLOSE = NOW + 60_000;

type UserRow = { _id: string; phone?: string; phoneVerified?: boolean };
type AuctionRow = {
  _id: string;
  status: "DRAFT" | "SCHEDULED" | "OPEN" | "CLOSED" | "SETTLED";
  startAt?: number;
  closeAt: number;
  feeSantim?: number;
  minBidSantim?: number;
  maxBidSantim?: number;
  antiSnipeWindowMs?: number;
  antiSnipeExtendMs?: number;
  antiSnipeMaxExtensions?: number;
  extensionCount?: number;
};
type BidRow = {
  _id: string;
  auctionId: string;
  bidderId: string;
  amountSantim: number;
  feeSantim: number;
  status: "ACCEPTED" | "REJECTED";
  rejectionReason?: string;
  refundStatus: string;
  placedAt: number;
  idempotencyKey: string;
};
type WalletRow = { _id: string; userId: string; availableSantim: number; updatedAt: number };
type LotRow = {
  _id: string;
  userId: string;
  originalSantim: number;
  remainingSantim: number;
  status: "open" | "exhausted";
  createdAt: number;
};
type LedgerEntryRow = { _id: string; kind: string; refType: string; refId: string; idempotencyKey: string; createdAt: number };
type LedgerPostingRow = { _id: string; entryId: string; account: string; userSide?: string; direction: "debit" | "credit"; amountSantim: number; provenanceLotIds?: string[]; createdAt: number };
type IdempotencyRow = { key: string; op: string; refType: string; refId: string; outcome: string; createdAt: number };
type AuditRow = Record<string, unknown>;

function makeStore(options: { failOnInsert?: string } = {}) {
  const users = new Map<string, UserRow>();
  const auctions = new Map<string, AuctionRow>();
  const bids: BidRow[] = [];
  const wallets = new Map<string, WalletRow>();
  const provenanceLots: LotRow[] = [];
  const ledgerEntries: LedgerEntryRow[] = [];
  const ledgerPostings: LedgerPostingRow[] = [];
  const idempotencyRecords = new Map<string, IdempotencyRow>();
  const auditEvents: AuditRow[] = [];
  let seq = 0;
  let failOnInsert = options.failOnInsert ?? null;

  const db = {
    async get(id: string) {
      return (
        users.get(id) ??
        auctions.get(id) ??
        wallets.get(id) ??
        provenanceLots.find((l) => l._id === id) ??
        null
      );
    },
    async insert(table: string, doc: Record<string, unknown>) {
      if (failOnInsert === table) throw new Error(`simulated insert failure on ${table}`);
      seq += 1;
      const id = `${table}:${seq}`;
      const row = { ...doc, _id: id };
      if (table === "bids") bids.push(row as unknown as BidRow);
      else if (table === "wallets") wallets.set(id, row as unknown as WalletRow);
      else if (table === "provenanceLots") provenanceLots.push(row as unknown as LotRow);
      else if (table === "ledgerEntries") ledgerEntries.push(row as unknown as LedgerEntryRow);
      else if (table === "ledgerPostings") ledgerPostings.push(row as unknown as LedgerPostingRow);
      else if (table === "idempotencyRecords") idempotencyRecords.set(doc.key as string, row as unknown as IdempotencyRow);
      else if (table === "auditEvents") auditEvents.push(row);
      else throw new Error(`unknown table ${table}`);
      return id;
    },
    async patch(id: string, doc: Record<string, unknown>) {
      const bid = bids.find((b) => b._id === id);
      if (bid) {
        Object.assign(bid, doc);
        return;
      }
      const auction = auctions.get(id);
      if (auction) {
        Object.assign(auction, doc);
        return;
      }
      const wallet = wallets.get(id);
      if (wallet) {
        Object.assign(wallet, doc);
        return;
      }
      const lot = provenanceLots.find((l) => l._id === id);
      if (lot) Object.assign(lot, doc);
    },
    query(table: string) {
      return {
        withIndex(_name: string, fn: (q: { eq: (f: string, v: unknown) => unknown }) => unknown) {
          let captured: { field: string; value: unknown } | null = null;
          fn({ eq: (field: string, value: unknown) => { captured = { field, value }; return value; } });
          const value = (captured as { field: string; value: unknown } | null)?.value;
          if (table === "idempotencyRecords") {
            return {
              unique: async () => idempotencyRecords.get(value as string) ?? null,
              collect: async () => (idempotencyRecords.get(value as string) ? [idempotencyRecords.get(value as string)] : []),
            };
          }
          if (table === "wallets") {
            return {
              unique: async () => [...wallets.values()].find((w) => w.userId === value) ?? null,
              collect: async () => [...wallets.values()].filter((w) => w.userId === value),
            };
          }
          if (table === "provenanceLots") {
            return {
              collect: async () => provenanceLots.filter((l) => l.userId === value),
            };
          }
          return { unique: async () => null, collect: async () => [] };
        },
      };
    },
  };

  return {
    ctx: { db },
    db,
    users,
    auctions,
    bids,
    wallets,
    provenanceLots,
    ledgerEntries,
    ledgerPostings,
    idempotencyRecords,
    auditEvents,
    setFailOnInsert: (table: string | null) => { failOnInsert = table; },
    snapshot(): string {
      return JSON.stringify({
        users: [...users.entries()], auctions: [...auctions.entries()], bids,
        wallets: [...wallets.entries()], provenanceLots, ledgerEntries,
        ledgerPostings, idempotencyRecords: [...idempotencyRecords.entries()],
        auditEvents, seq,
      });
    },
    restore(snapshot: string): void {
      const s = JSON.parse(snapshot) as {
        users: [string, UserRow][]; auctions: [string, AuctionRow][]; bids: BidRow[];
        wallets: [string, WalletRow][]; provenanceLots: LotRow[];
        ledgerEntries: LedgerEntryRow[]; ledgerPostings: LedgerPostingRow[];
        idempotencyRecords: [string, IdempotencyRow][]; auditEvents: AuditRow[]; seq: number;
      };
      users.clear(); for (const [k, v] of s.users) users.set(k, v);
      auctions.clear(); for (const [k, v] of s.auctions) auctions.set(k, v);
      bids.length = 0; bids.push(...s.bids);
      wallets.clear(); for (const [k, v] of s.wallets) wallets.set(k, v);
      provenanceLots.length = 0; provenanceLots.push(...s.provenanceLots);
      ledgerEntries.length = 0; ledgerEntries.push(...s.ledgerEntries);
      ledgerPostings.length = 0; ledgerPostings.push(...s.ledgerPostings);
      idempotencyRecords.clear(); for (const [k, v] of s.idempotencyRecords) idempotencyRecords.set(k, v);
      auditEvents.length = 0; auditEvents.push(...s.auditEvents);
      seq = s.seq;
    },
  };
}

/* ── Seeds / helpers ── */

function seedOpenAuction(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<AuctionRow> = {},
): AuctionRow {
  const row: AuctionRow = {
    _id: AUCTION,
    status: "OPEN",
    startAt: NOW - 10_000,
    closeAt: CLOSE,
    feeSantim: 100, // configured fee (value OPEN in the product; set here for tests)
    extensionCount: 0, // Phase G creation always writes this
    ...overrides,
  };
  store.auctions.set(row._id, row);
  return row;
}

function seedBidder(store: ReturnType<typeof makeStore>, opts: { phoneVerified?: boolean; balance?: number } = {}) {
  store.users.set(BIDDER, { _id: BIDDER, phone: "+251911000001", phoneVerified: opts.phoneVerified ?? true });
  if (opts.balance !== undefined) {
    store.wallets.set(`wallets:w-${BIDDER}`, { _id: `wallets:w-${BIDDER}`, userId: BIDDER, availableSantim: opts.balance, updatedAt: NOW });
  }
  return BIDDER;
}

function seedProvenanceLot(store: ReturnType<typeof makeStore>, userId: string, remainingSantim: number, createdAt = NOW) {
  const id = `provenanceLots:p${store.provenanceLots.length + 1}`;
  store.provenanceLots.push({ _id: id, userId, originalSantim: remainingSantim, remainingSantim, status: "open", createdAt });
  return id;
}

function acceptedBidCount(store: ReturnType<typeof makeStore>): number {
  return store.bids.filter((b) => b.status === "ACCEPTED").length;
}

function auditCount(store: ReturnType<typeof makeStore>, action: string): number {
  return store.auditEvents.filter((a) => a.action === action).length;
}

const BID = { auctionId: AUCTION, idempotencyToken: "tok-1", amountSantim: 500 };

/* ── 1. Pure decision core ── */

describe("bid decision core (pure)", () => {
  test("time window: OPEN within window accepted", () => {
    expect(
      evaluateBidTimeWindow({ status: "OPEN", startAt: NOW - 1_000, closeAt: CLOSE, now: NOW }),
    ).toEqual({ ok: true });
  });
  test("time window: non-OPEN status refused (not_open)", () => {
    for (const status of ["DRAFT", "SCHEDULED", "CLOSED", "SETTLED"] as const) {
      expect(
        evaluateBidTimeWindow({ status, startAt: undefined, closeAt: CLOSE, now: NOW }),
      ).toEqual({ ok: false, reason: "not_open" });
    }
  });
  test("time window: before start refused; at/after close too_late (boundary inclusive)", () => {
    expect(
      evaluateBidTimeWindow({ status: "OPEN", startAt: NOW + 5_000, closeAt: CLOSE, now: NOW }),
    ).toEqual({ ok: false, reason: "not_open" });
    expect(
      evaluateBidTimeWindow({ status: "OPEN", startAt: undefined, closeAt: NOW, now: NOW }),
    ).toEqual({ ok: false, reason: "too_late" });
    expect(
      evaluateBidTimeWindow({ status: "OPEN", startAt: undefined, closeAt: NOW + 1, now: NOW + 1 }),
    ).toEqual({ ok: false, reason: "too_late" });
  });
  test("policy: unset fee fails safely as bid_fee_unconfigured", () => {
    expect(
      evaluateBidPolicy({ amountSantim: 500, minBidSantim: null, maxBidSantim: null, feeSantim: null }),
    ).toEqual({ ok: false, reason: "bid_fee_unconfigured" });
    expect(
      evaluateBidPolicy({ amountSantim: 500, minBidSantim: null, maxBidSansom: null, feeSantim: undefined } as never),
    ).toEqual({ ok: false, reason: "bid_fee_unconfigured" });
  });
  test("policy: invalid configured fee (zero/negative/fractional) refused", () => {
    for (const fee of [0, -5, 10.5]) {
      expect(
        evaluateBidPolicy({ amountSantim: 500, minBidSantim: null, maxBidSantim: null, feeSantim: fee }),
      ).toEqual({ ok: false, reason: "invalid_fee_config" });
    }
  });
  test("policy: bounds enforced when configured, ignored when unset", () => {
    expect(
      evaluateBidPolicy({ amountSantim: 99, minBidSantim: 100, maxBidSantim: null, feeSantim: 10 }),
    ).toEqual({ ok: false, reason: "out_of_range" });
    expect(
      evaluateBidPolicy({ amountSantim: 1_000, minBidSantim: null, maxBidSantim: 500, feeSantim: 10 }),
    ).toEqual({ ok: false, reason: "out_of_range" });
    expect(
      evaluateBidPolicy({ amountSantim: 1, minBidSantim: null, maxBidSantim: null, feeSantim: 10 }).ok,
    ).toBe(true);
  });
  test("policy: invalid amount / inverted bounds classes", () => {
    expect(
      evaluateBidPolicy({ amountSantim: 0, minBidSantim: null, maxBidSantim: null, feeSantim: 10 }),
    ).toEqual({ ok: false, reason: "invalid_amount" });
    expect(
      evaluateBidPolicy({ amountSantim: -5, minBidSantim: null, maxBidSantim: null, feeSantim: 10 }),
    ).toEqual({ ok: false, reason: "invalid_amount" });
    expect(
      evaluateBidPolicy({ amountSantim: 10.5, minBidSantim: null, maxBidSantim: null, feeSantim: 10 }),
    ).toEqual({ ok: false, reason: "invalid_amount" });
    expect(
      evaluateBidPolicy({ amountSantim: 100, minBidSantim: 500, maxBidSantim: 100, feeSantim: 10 }),
    ).toEqual({ ok: false, reason: "invalid_bounds" });
  });
});

/* ── 2. Successful acceptance: the full economic effect ── */

describe("submitBid — acceptance", () => {
  test("valid bid: accepted, fee charged atomically, balanced ledger, provenance consumed", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);

    const result = await submitBid(store.ctx, {
      auctionId: AUCTION,
      bidderId: BIDDER,
      idempotencyToken: "tok-1",
      amountSantim: 500,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "accepted") throw new Error("expected accepted");

    // Exact bid row:
    expect(store.bids.length).toBe(1);
    const bid = store.bids[0];
    expect(bid?.status).toBe("ACCEPTED");
    expect(bid?.amountSantim).toBe(500);
    expect(bid?.feeSantim).toBe(100); // the configured fee, server-computed
    expect(bid?.refundStatus).toBe("not_refundable");

    // Exact wallet decrease:
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(900);
    expect(result.walletBalanceSantim).toBe(900);

    // Provenance lot consumed (newest-first caller order):
    expect(store.provenanceLots.length).toBe(1);
    expect(store.provenanceLots[0]?.remainingSantim).toBe(900);
    expect(store.provenanceLots[0]?.status).toBe("open");

    // Balanced ledger: debit wallet / credit platform revenue:
    expect(store.ledgerEntries.length).toBe(1);
    expect(store.ledgerEntries[0]?.kind).toBe("bid_fee");
    expect(store.ledgerEntries[0]?.refType).toBe("bid");
    expect(store.ledgerEntries[0]?.refId).toBe(result.bidId);
    expect(store.ledgerPostings.length).toBe(2);
    expect(transactionBalance(store.ledgerPostings as never)).toBe(0);
    const walletPosting = store.ledgerPostings.find((p) => p.account === `wallet:${BIDDER}`);
    expect(walletPosting?.direction).toBe("debit");
    expect(walletPosting?.amountSantim).toBe(100);
    const platformPosting = store.ledgerPostings.find((p) => p.account === "platform:bid_fee_revenue");
    expect(platformPosting?.direction).toBe("credit");
    expect(platformPosting?.amountSantim).toBe(100);

    // Audit: the fee ledger post writes its own kind→action audit
    // (bid_fee → bid.accepted) plus the explicit acceptance audit = 2.
    expect(auditCount(store, "bid.accepted")).toBe(2);
    expect(store.idempotencyRecords.size).toBe(2);
    // Anti-snipe unset ⇒ inactive:
    expect(result.antiSnipeNewCloseAt).toBeNull();
  });

  test("provenance consumption spans multiple lots (caller order) and exhausts them", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 300 });
    seedProvenanceLot(store, BIDDER, 100, NOW); // older
    seedProvenanceLot(store, BIDDER, 200, NOW + 5_000); // newer — consumed first

    const result = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-multi",
      amountSantim: 700, now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "accepted") throw new Error("expected accepted");
    // Fee (100) consumes only the newest lot (200) partially — it stays
    // open with 100 remaining; the older lot is untouched at 100:
    const newer = store.provenanceLots.find((l) => l.originalSantim === 200);
    expect(newer?.remainingSantim).toBe(100);
    expect(newer?.status).toBe("open");
    expect(store.provenanceLots.find((l) => l.originalSantim === 100)?.remainingSantim).toBe(100);
    // Wallet decreased by the fee only:
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(200);
  });
});

/* ── 3. Rejections — zero economic effect ── */

describe("submitBid — rejections", () => {
  test("non-OPEN auction: rejected with REJECTED row, zero economic effect", async () => {
    const store = makeStore();
    seedOpenAuction(store, { status: "CLOSED" });
    seedBidder(store, { balance: 1_000 });

    const result = await submitBid(store.ctx, { ...BID, bidderId: BIDDER, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== "rejected") throw new Error("expected rejected");
    expect(result.reason).toBe("not_open");
    // Honest transactional status: REJECTED row persisted with the frozen reason.
    expect(store.bids.length).toBe(1);
    expect(store.bids[0]?.status).toBe("REJECTED");
    expect(store.bids[0]?.rejectionReason).toBe("not_open");
    // Zero economic effect: no wallet movement, no ledger entry, no lot consumption.
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(1_000);
    expect(store.ledgerEntries.length).toBe(0);
    expect(auditCount(store, "bid.rejected")).toBe(1);
    expect(store.idempotencyRecords.size).toBe(1); // the rejection outcome is replayable
  });

  test("after close: too_late (server time, boundary inclusive)", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });

    const result = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-late",
      amountSantim: 500, now: CLOSE,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== "rejected") throw new Error("expected rejected");
    expect(result.reason).toBe("too_late");
    expect(store.ledgerEntries.length).toBe(0);
  });

  test("unset fee policy: refused safely with no bid row and no effect", async () => {
    const store = makeStore();
    seedOpenAuction(store, { feeSantim: undefined });
    seedBidder(store, { balance: 1_000 });

    const result = await submitBid(store.ctx, { ...BID, bidderId: BIDDER, now: NOW });
    expect(result).toEqual({
      ok: false, status: "refused", reason: "bid_fee_unconfigured",
    });
    // No bid row, no economic effect, no idempotency commit (retryable once
    // configuration exists).
    expect(store.bids.length).toBe(0);
    expect(store.ledgerEntries.length).toBe(0);
    expect(store.idempotencyRecords.size).toBe(0);
  });

  test("out-of-range amount with configured bounds: REJECTED row, zero effect", async () => {
    const store = makeStore();
    seedOpenAuction(store, { minBidSantim: 100, maxBidSantim: 400 });
    seedBidder(store, { balance: 1_000 });

    const result = await submitBid(store.ctx, { ...BID, bidderId: BIDDER, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== "rejected") throw new Error("expected rejected");
    expect(result.reason).toBe("out_of_range");
    expect(store.bids[0]?.status).toBe("REJECTED");
    expect(store.ledgerEntries.length).toBe(0);
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(1_000);
  });

  test("insufficient balance: ACCEPTED row patched to REJECTED before any money moves", async () => {
    const store = makeStore();
    expect(store.wallets.size).toBe(0);
    seedOpenAuction(store);
    seedBidder(store, { balance: 50 }); // fee is 100

    const result = await submitBid(store.ctx, { ...BID, bidderId: BIDDER, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== "rejected") throw new Error("expected rejected");
    expect(result.reason).toBe("insufficient_funds");
    // The bid row was patched to REJECTED (schema-sanctioned audit row):
    expect(store.bids.length).toBe(1);
    expect(store.bids[0]?.status).toBe("REJECTED");
    expect(store.bids[0]?.rejectionReason).toBe("insufficient_funds");
    expect(store.bids[0]?.feeSantim).toBe(0);
    // Zero economic effect:
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(50);
    expect(store.ledgerEntries.length).toBe(0);
    expect(store.provenanceLots.length).toBe(0);
    expect(auditCount(store, "bid.rejected")).toBe(1);
  });

  test("auction not found: refused, no rows", async () => {
    const store = makeStore();
    seedBidder(store, { balance: 1_000 });

    const result = await submitBid(store.ctx, {
      auctionId: "auctions:missing" as Id<"auctions">, bidderId: BIDDER,
      idempotencyToken: "tok-x", amountSantim: 500, now: NOW,
    });
    expect(result).toEqual({ ok: false, status: "refused", reason: "auction_not_found" });
    expect(store.bids.length).toBe(0);
  });
});

/* ── 4. Idempotency — retries never double-charge ── */

describe("submitBid — idempotency", () => {
  test("exact replay of an accepted bid returns the original result, zero new effect", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);

    const input = { auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-1", amountSantim: 500, now: NOW };
    const first = await submitBid(store.ctx, input);
    expect(first.ok && first.status === "accepted").toBe(true);
    const before = store.snapshot();

    const second = await submitBid(store.ctx, { ...input, now: NOW + 5_000 });
    expect(second).toMatchObject({ ok: true, status: "replay", bidId: first.ok && first.status === "accepted" ? first.bidId : null });
    // Zero new effect: wallet unchanged, one ledger entry, one lot movement.
    expect(store.snapshot()).toBe(before);
  });

  test("replay of a rejected bid returns the frozen reason, zero new effect", async () => {
    const store = makeStore();
    seedOpenAuction(store, { status: "CLOSED" });
    seedBidder(store, { balance: 1_000 });

    const input = { auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-r", amountSantim: 500, now: NOW };
    const first = await submitBid(store.ctx, input);
    expect(!first.ok && first.reason === "not_open").toBe(true);
    const before = store.snapshot();

    const second = await submitBid(store.ctx, input);
    expect(second.ok).toBe(false);
    expect(second.ok ? null : second.reason).toBe("not_open");
    expect(store.snapshot()).toBe(before);
  });

  test("changed request with the same key is a conflict (no silent reuse)", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);

    const first = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-c", amountSantim: 500, now: NOW,
    });
    expect(first.ok).toBe(true);

    const second = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-c", amountSantim: 600, now: NOW,
    });
    expect(second).toEqual({ ok: false, status: "refused", reason: "idempotency_conflict" });
    // Only the original accepted bid + fee exist:
    expect(acceptedBidCount(store)).toBe(1);
    expect(store.ledgerEntries.length).toBe(1);
  });

  test("cross-user replay is structurally impossible (user-bound keys)", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });
    store.users.set(OTHER, { _id: OTHER, phone: "+251911000002", phoneVerified: true });
    store.wallets.set("wallets:w2", { _id: "wallets:w2", userId: OTHER, availableSantim: 1_000, updatedAt: NOW });
    seedProvenanceLot(store, BIDDER, 1_000);
    seedProvenanceLot(store, OTHER, 1_000);

    await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-shared", amountSantim: 500, now: NOW,
    });
    const other = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: OTHER, idempotencyToken: "tok-shared", amountSantim: 500, now: NOW,
    });
    // Same token, different user ⇒ a DIFFERENT key ⇒ an independent accepted bid.
    expect(other.ok).toBe(true);
    expect(acceptedBidCount(store)).toBe(2);
  });
});

/* ── 5. Concurrency / OCC ── */

describe("submitBid — concurrency and races", () => {
  test("concurrent duplicate submissions serialize — exactly one economic effect", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);

    // Two identical submissions (same key) run sequentially here, mirroring
    // OCC serialization: the loser re-executes and hits the replay path.
    const input = { auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-dup", amountSantim: 500, now: NOW };
    const results = [];
    for (let i = 0; i < 2; i++) {
      results.push(await submitBid(store.ctx, input));
    }
    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: true, status: "replay" });
    expect(acceptedBidCount(store)).toBe(1);
    expect(store.ledgerEntries.length).toBe(1);
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(900);
  });

  test("two users spending the same available wallet balance — per-user wallets serialize independently", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    // Shared pool scenario: two users, each draining a 100 balance with a 100 fee.
    seedBidder(store, { balance: 100 });
    store.users.set(OTHER, { _id: OTHER, phone: "+251911000002", phoneVerified: true });
    store.wallets.set("wallets:w2", { _id: "wallets:w2", userId: OTHER, availableSantim: 100, updatedAt: NOW });
    seedProvenanceLot(store, BIDDER, 100);
    seedProvenanceLot(store, OTHER, 100);

    const a = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-a", amountSantim: 500, now: NOW,
    });
    const b = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: OTHER, idempotencyToken: "tok-b", amountSantim: 500, now: NOW,
    });
    // Both succeed independently: wallets are per-user (no shared contention).
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    for (const w of store.wallets.values()) expect(w.availableSantim).toBe(0);
    expect(store.ledgerEntries.length).toBe(2);
  });

  test("stale-read/OCC retry: a failed transaction leaves zero partial state", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);
    const before = store.snapshot();

    // Inject a mid-transaction failure after the bid row insert (the fee's
    // idempotency insert is the next write) — a thrown Convex transaction
    // removes ALL writes; emulate via snapshot/restore.
    store.setFailOnInsert("ledgerEntries");
    let threw = false;
    try {
      await submitBid(store.ctx, {
        auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-occ", amountSantim: 500, now: NOW,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    store.setFailOnInsert(null); // clear the sticky flag before the retry
    store.restore(before);
    // Zero partial state: no bid row, no wallet movement, no lot consumption.
    expect(store.bids.length).toBe(0);
    const wallet = [...store.wallets.values()].find((w) => w.userId === BIDDER);
    expect(wallet?.availableSantim).toBe(1_000);
    expect(store.provenanceLots[0]?.remainingSantim).toBe(1_000);
    // A clean retry then succeeds exactly once:
    const retry = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-occ", amountSantim: 500, now: NOW,
    });
    expect(retry.ok).toBe(true);
    expect(acceptedBidCount(store)).toBe(1);
  });

  test("concurrent bids at the close boundary — the loser is too_late after time passes", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 1_000 });

    // Bid A at the last instant before close; bid B arrives after closeAt.
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);
    store.users.set(OTHER, { _id: OTHER, phone: "+251911000002", phoneVerified: true });
    store.wallets.set("wallets:w2", { _id: "wallets:w2", userId: OTHER, availableSantim: 1_000, updatedAt: NOW });
    seedProvenanceLot(store, OTHER, 1_000);
    const a = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-a1", amountSantim: 500, now: CLOSE - 1,
    });
    expect(a.ok).toBe(true);
    const b = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: OTHER, idempotencyToken: "tok-b1", amountSantim: 500, now: CLOSE,
    });
    expect(b.ok).toBe(false);
    expect(b.ok ? null : b.reason).toBe("too_late");
  });

  test("wallet balance validation races with balance changes — insufficient wins when drained", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 100 }); // fee is 100 — exactly enough
    seedProvenanceLot(store, BIDDER, 100);

    const first = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-f", amountSantim: 500, now: NOW,
    });
    expect(first.ok).toBe(true);
    // Same user, second bid: wallet now at 0 ⇒ clean insufficient_funds.
    const second = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-s", amountSantim: 500, now: NOW,
    });
    expect(second.ok).toBe(false);
    expect(second.ok ? null : second.reason).toBe("insufficient_funds");
    expect(store.bids.filter((b) => b.status === "REJECTED").length).toBe(1);
    expect(store.ledgerEntries.length).toBe(1);
  });
});

/* ── 6. Anti-snipe integration ── */

describe("submitBid — anti-snipe integration", () => {
  test("accepted bid inside the window extends close atomically; rejected bid does not", async () => {
    const store = makeStore();
    seedOpenAuction(store, {
      antiSnipeWindowMs: 30_000,
      antiSnipeExtendMs: 15_000,
      antiSnipeMaxExtensions: 1,
    });
    seedBidder(store, { balance: 1_000 });
    seedProvenanceLot(store, BIDDER, 1_000);

    // Accepted bid inside the window ⇒ extension applies:
    const a = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-as1", amountSantim: 500, now: CLOSE - 10_000,
    });
    expect(a.ok && a.status === "accepted").toBe(true);
    if (!a.ok || a.status !== "accepted") throw new Error("expected accepted");
    expect(a.antiSnipeNewCloseAt).toBe(CLOSE + 15_000);
    expect(store.auctions.get(AUCTION)?.closeAt).toBe(CLOSE + 15_000);
    expect(store.auctions.get(AUCTION)?.extensionCount).toBe(1);
    expect(auditCount(store, "auction.antisnipe_extended")).toBe(1);

    // A REJECTED bid inside the (new) window never triggers the seam:
    const late = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-as2", amountSantim: 500, now: CLOSE + 15_000,
    });
    expect(late.ok).toBe(false);
    expect(store.auctions.get(AUCTION)?.extensionCount).toBe(1); // unchanged
  });

  test("anti-snipe unset ⇒ inactive with zero effect; max extensions bound applies", async () => {
    const store = makeStore();
    seedOpenAuction(store);
    seedBidder(store, { balance: 10_000 });
    seedProvenanceLot(store, BIDDER, 10_000);

    const r = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-as3", amountSantim: 500, now: CLOSE - 1_000,
    });
    expect(r.ok).toBe(true);
    expect(store.auctions.get(AUCTION)?.closeAt).toBe(CLOSE);

    // Bounded: configure max 1, take it, then the next accepted bid inside
    // the new window refuses extension (exhausted) but the bid still succeeds.
    const auction = store.auctions.get(AUCTION);
    if (auction) {
      auction.antiSnipeWindowMs = 30_000;
      auction.antiSnipeExtendMs = 15_000;
      auction.antiSnipeMaxExtensions = 1;
      auction.extensionCount = 1; // already at max
    }
    const r2 = await submitBid(store.ctx, {
      auctionId: AUCTION, bidderId: BIDDER, idempotencyToken: "tok-as4", amountSantim: 500, now: CLOSE - 500,
    });
    expect(r2.ok).toBe(true);
    expect(store.auctions.get(AUCTION)?.closeAt).toBe(CLOSE);
  });
});

/* ── 7. Blind-bidding projection safety ── */

describe("own-bid projection — blind safety", () => {
  test("projection exposes exactly the frozen self-visible fields", () => {
    const projected = projectOwnBids([
      {
        _id: "bids:1", auctionId: AUCTION, bidderId: BIDDER, amountSantim: 500,
        feeSantim: 100, status: "ACCEPTED", refundStatus: "not_refundable",
        placedAt: NOW, idempotencyKey: "k", bidderNote: "internal", rank: 1,
        isUnique: true, distribution: [1, 2, 3],
      },
    ]);
    expect(projected.length).toBe(1);
    const bid = projected[0];
    expect(bid && Object.keys(bid).sort()).toEqual([
      "amountSantim", "auctionId", "feeSantim", "id", "placedAt",
      "refundStatus", "rejectionReason", "status",
    ]);
    // Prohibited intelligence is structurally absent:
    expect(bid && "isUnique" in bid).toBe(false);
    expect(bid && "rank" in bid).toBe(false);
    expect(bid && "distribution" in bid).toBe(false);
  });

  test("rejected bids project their frozen reason class only", () => {
    const projected = projectOwnBids([
      {
        _id: "bids:2", auctionId: AUCTION, bidderId: BIDDER, amountSantim: 500,
        feeSantim: 0, status: "REJECTED", rejectionReason: "insufficient_funds",
        refundStatus: "not_refundable", placedAt: NOW, idempotencyKey: "k2",
      },
    ]);
    expect(projected[0]?.status).toBe("REJECTED");
    expect(projected[0]?.rejectionReason).toBe("insufficient_funds");
    expect(projected[0]?.feeSantim).toBe(0);
  });
});

/* ── 8. Surface-level guard rejections (auth) ── */

describe("auth guards on the bid path", () => {
  test("unauthenticated rejection is fail-closed at the guard layer (pure evaluator)", async () => {
    const { evaluateVerifiedPhoneUser } = await import("../guards/auth");
    // No user row at all (no session) ⇒ refused.
    const anonymous = evaluateVerifiedPhoneUser(null as never);
    expect(anonymous.ok).toBe(false);
    expect(anonymous.ok ? null : anonymous.reason).toBe("unauthenticated");
  });

  test("unverified phone is fail-closed at the guard layer (pure evaluator)", async () => {
    const { evaluateVerifiedPhoneUser } = await import("../guards/auth");
    const unverified = { _id: BIDDER, phone: "+251911000001", phoneVerified: false };
    const result = evaluateVerifiedPhoneUser(unverified as never);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe("unverified_phone");
    const missing = { _id: BIDDER, phone: undefined, phoneVerified: false };
    const missingResult = evaluateVerifiedPhoneUser(missing as never);
    expect(missingResult.ok).toBe(false);
  });
});
