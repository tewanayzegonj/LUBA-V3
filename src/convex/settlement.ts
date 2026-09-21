/**
 * LUBA V1 — settlement Convex surface (Phase I, frozen plan §9/§12/§14/§15).
 *
 * The ONE public mutation is `settleAuction` (winner-only, verified phone,
 * server-resolved identity, server-read amount). Everything else is
 * internal: finalize/void/refund/backstop workers run WITHOUT user auth —
 * they never call getAuthUserId, and their idempotency derives from
 * system-owned data. Public projections expose only the approved shapes:
 *
 *   - during OPEN: blind bidding preserved (no bid data at all);
 *   - CLOSED + pending settlement: NO public result/amount/winner/count;
 *     the WINNER (ownership-enforced) sees their own pending state + deadline;
 *   - SETTLED: the approved public result (outcome, winning amount iff
 *     WINNER, close time, final accepted-bid count, winner display name
 *     only with consent — publicWinnerConsent && publicDisplayName).
 *
 * No visibility expansion. No CLOSING state. Server bid acceptance remains
 * the authority for bidding; this surface never accepts money amounts.
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireVerifiedPhoneUser } from "./guards/auth";
import {
  createFinalizationHook,
  processRefundChunk,
  settleWinner,
  sweepStalledCampaigns,
  sweepVoidExpiredSettlements,
  type SettlementCtx,
} from "./financial/settlement";
import { sweepCloseExpired } from "./auction/lifecycle";
import { ensureWallet } from "./financial/wallet";

/* ── Structural shape for the internal seams ── */

type SurfaceDb = {
  get: (id: string) => Promise<Record<string, unknown> & { _id: string } | null>;
  patch: (id: string, doc: Record<string, unknown>) => Promise<void>;
  insert: (table: string, doc: Record<string, unknown>) => Promise<string>;
  query: (table: string) => {
    withIndex: (
      name: string,
      fn: (q: never) => never,
    ) => {
      unique: () => Promise<(Record<string, unknown> & { _id: string }) | null>;
      collect: () => Promise<Array<Record<string, unknown> & { _id: string }>>;
    };
  };
};

function settlementCtx(ctx: { db: unknown } & Record<string, unknown>): SettlementCtx {
  const raw = ctx as unknown as {
    db: SurfaceDb;
    scheduleNextRefundChunk?: SettlementCtx["scheduleNextRefundChunk"];
  };
  // Internal workers run identity-free; chunk continuation is wired to the
  // Convex scheduler target below (test fakes may inject their own).
  return {
    db: raw.db,
    scheduleNextRefundChunk:
      raw.scheduleNextRefundChunk ?? (async () => {}),
  } as unknown as SettlementCtx;
}

/* ══════════════════ Public settle mutation ══════════════════ */

export const settleAuction = mutation({
  args: { auctionId: v.id("auctions") },
  handler: async (ctx, args) => {
    // Identity resolved SERVER-side via the Phase B/C guard (session auth +
    // fail-closed verified phone). The client never asserts an actor and
    // never supplies an amount.
    const guard = await requireVerifiedPhoneUser({
      auth: ctx.auth,
      db: ctx.db,
    });
    if (!guard.ok) {
      return { ok: false as const, status: "refused" as const, reason: guard.reason };
    }
    const userId = guard.value.userId;
    // Wallet must exist (1:1, zero-start) before the settlement debit.
    await ensureWallet(ctx, userId);
    return settleWinner(ctx as unknown as SettlementCtx, {
      auctionId: args.auctionId,
      callerId: userId,
      phoneVerified: true,
      now: Date.now(),
    });
  },
});

/* ══════════════════ Internal workers (no auth — system identity) ══════════════════ */

/** Close sweep WITH the Phase I finalization hook composed (cron #2). */
export const internalSweepCloseExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    return sweepCloseExpired(ctx as unknown as Parameters<typeof sweepCloseExpired>[0], {
      now: Date.now(),
      finalize: createFinalizationHook(),
    });
  },
});

/** Deadline void sweep (cron #3): voided + RELEASE + refunds campaign. */
export const internalSweepVoidExpiredSettlements = internalMutation({
  args: {},
  handler: async (ctx) => {
    return sweepVoidExpiredSettlements(settlementCtx(ctx as never), { now: Date.now() });
  },
});

/**
 * Refund chunk worker: one chunk per invocation, self-scheduling the next
 * via the scheduler. The real Convex scheduler target lives in
 * `internalProcessRefundChunkScheduled`, which re-reads the campaign and
 * calls this primitive.
 */
export const internalProcessRefundChunk = internalMutation({
  args: { campaignId: v.id("settlementCampaigns") },
  handler: async (ctx, args) => {
    return processRefundChunk(settlementCtx(ctx as never), {
      campaignId: args.campaignId,
      now: Date.now(),
    });
  },
});

/**
 * Scheduler target for chunk continuation (ctx.scheduler.runAfter(0)).
 * Scheduled functions inherit NO auth — this worker is identity-free by
 * construction; exactly-once is per-bid/system-keyed (frozen plan §13).
 */
export const internalProcessRefundChunkScheduled = internalMutation({
  args: { campaignId: v.id("settlementCampaigns") },
  handler: async (ctx, args) => {
    await processRefundChunk(settlementCtx(ctx as never), {
      campaignId: args.campaignId,
      now: Date.now(),
    });
  },
});

/** Campaign backstop (cron #4): re-kicks in_progress campaigns only. */
export const internalSweepStalledCampaigns = internalMutation({
  args: {},
  handler: async (ctx) => {
    return sweepStalledCampaigns(settlementCtx(ctx as never), { now: Date.now() });
  },
});

/* ══════════════════ Projections (frozen plan §15) ══════════════════ */

type CtxRow = Record<string, unknown> & { _id: string };

/**
 * Winner-only pending settlement view: ownership-enforced (server-side
 * caller check against settlementRecords.winnerId); exposes only the
 * winner's own pending settlement state. Null when not the winner.
 */
export const getMySettlement = query({
  args: { auctionId: v.id("auctions") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const record = await ctx.db
      .query("settlementRecords")
      .withIndex("by_auction", (q) => q.eq("auctionId", args.auctionId))
      .unique();
    if (record === null) return null;
    if (record.winnerId !== userId) return null; // IDOR-resistant by construction
    return {
      status: record.status, // pending | paid | voided
      amountSantim: record.amountSantim,
      deadline: record.deadline,
      paidAt: record.paidAt ?? null,
      voidedAt: record.voidedAt ?? null,
    };
  },
});

/**
 * Public settled-result projection — the approved post-SETTLED shape only.
 * CLOSED auctions (pending or otherwise) expose NO result/amount/winner/
 * count. Display name appears only with explicit consent.
 */
export const getPublicSettledResult = query({
  args: { auctionId: v.id("auctions") },
  handler: async (ctx, args) => {
    const auction = await ctx.db.get(args.auctionId);
    if (auction === null) return null;
    if (auction.status !== "SETTLED") return null; // CLOSED exposes nothing here
    const result = await ctx.db
      .query("auctionResults")
      .withIndex("by_auction", (q) => q.eq("auctionId", args.auctionId))
      .unique();
    if (result === null) return null;

    const base = {
      result: result.result,
      winningAmountSantim: result.result === "WINNER" ? result.winningAmountSantim : null,
      closeTime: result.closeTime,
      finalAcceptedBidCount: result.finalAcceptedBidCount,
    };

    if (result.result !== "WINNER" || result.winningBidId === undefined) return base;
    const winningBid = await ctx.db.get(result.winningBidId);
    if (winningBid === null) return base;
    const winner = await ctx.db.get(winningBid.bidderId);
    // Frozen consent rule: display name ONLY when publicWinnerConsent &&
    // publicDisplayName. Winning never implies consent.
    const consented =
      winner !== null && winner.publicWinnerConsent === true && winner.publicDisplayName !== null;
    return {
      ...base,
      winnerDisplayName: consented ? winner!.publicDisplayName : null,
    };
  },
});
