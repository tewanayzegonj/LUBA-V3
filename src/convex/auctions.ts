/**
 * LUBA V1 — Convex function surface for auctions (Phase G).
 *
 * Public surface (operator-only mutations + read-only public queries):
 *  - `createAuction` / `configureAuction` / `publishAuction` / `openAuction`
 *    — every actor is resolved SERVER-side via the Phase C `requireOperator`
 *    guard; the server clock (`Date.now()`) is the only decision time
 *    (TRD §17). No client-authoritative business values anywhere.
 *  - `getPublicAuction` / `listPublicAuctions` — the approved public
 *    projection ONLY: no blind-bidding internals (no winner, uniqueness,
 *    ranking, distribution, lowest-unique), no operator-only config.
 *
 * Internal seams (scheduled functions / later phases only):
 *  - `internalSweepOpenScheduled` — the scheduled→open backstop
 *    (cron-registered in `crons.json`).
 *  - `internalSweepCloseExpired` — the close backstop SEAM, deliberately
 *    NOT cron-registered until Phase I composes the finalization hook
 *    (see `auction/lifecycle.ts`): a result-less CLOSED auction must never
 *    exist in the frozen model.
 *
 * OPEN decisions untouched: bid fee/model (`feeSantim` is accepted only as
 * explicit operator config), min/max bid, duplicate-amount rule, bid-volume
 * cap, anti-snipe values (all-or-nothing, unset ⇒ inactive), settlement
 * deadline (not a config input — set at finalization), inventory-line
 * backing, provider configuration.
 */
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

import { requireOperator } from "./guards/auth";
import type { AuctionCtx } from "./auction/create";
import { createAuctionRow, updateAuctionConfigRow } from "./auction/create";
import {
  isPubliclyVisibleStatus,
  projectPublicAuctionDetail,
  projectPublicAuctionSummary,
} from "./domain/auctions";
import type { AuctionStatus, FulfillmentMethod } from "./domain/contracts";
import {
  openAuction as openAuctionPrimitive,
  publishAuction as publishAuctionPrimitive,
  sweepCloseExpired,
  sweepOpenScheduled,
} from "./auction/lifecycle";

const auctionId = v.id("auctions");

/* ══════════════════════════ Operator mutations ══════════════════════════ */

export const createAuction = mutation({
  args: {
    code: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    prizeId: v.id("prizes"),
    closeAt: v.number(),
    startAt: v.optional(v.number()),
    fulfillmentMethod: v.union(v.literal("delivery"), v.literal("pickup")),
    pickupDetails: v.optional(v.string()),
    feeSantim: v.optional(v.number()),
    minBidSantim: v.optional(v.number()),
    maxBidSantim: v.optional(v.number()),
    antiSnipeWindowMs: v.optional(v.number()),
    antiSnipeExtendMs: v.optional(v.number()),
    antiSnipeMaxExtensions: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; reason?: string; auctionId?: Id<"auctions"> }> => {
    const operator = await requireOperator(ctx);
    if (!operator.ok) return { ok: false, reason: operator.reason };
    const result = await createAuctionRow(ctx as unknown as AuctionCtx, {
      operatorUserId: operator.value.userId,
      config: {
        code: args.code,
        title: args.title,
        description: args.description,
        prizeId: args.prizeId,
        closeAt: args.closeAt,
        startAt: args.startAt,
        fulfillmentMethod: args.fulfillmentMethod,
        pickupDetails: args.pickupDetails,
        feeSantim: args.feeSantim,
        minBidSantim: args.minBidSantim,
        maxBidSantim: args.maxBidSantim,
        antiSnipeWindowMs: args.antiSnipeWindowMs,
        antiSnipeExtendMs: args.antiSnipeExtendMs,
        antiSnipeMaxExtensions: args.antiSnipeMaxExtensions,
      },
      now: Date.now(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, auctionId: result.auctionId };
  },
});

export const configureAuction = mutation({
  args: {
    auctionId,
    code: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    closeAt: v.optional(v.number()),
    startAt: v.optional(v.number()),
    fulfillmentMethod: v.optional(v.union(v.literal("delivery"), v.literal("pickup"))),
    pickupDetails: v.optional(v.string()),
    feeSantim: v.optional(v.number()),
    minBidSantim: v.optional(v.number()),
    maxBidSantim: v.optional(v.number()),
    antiSnipeWindowMs: v.optional(v.number()),
    antiSnipeExtendMs: v.optional(v.number()),
    antiSnipeMaxExtensions: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const operator = await requireOperator(ctx);
    if (!operator.ok) return { ok: false, reason: operator.reason };
    const patch: Record<string, unknown> = {};
    if (args.code !== undefined) patch.code = args.code;
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.closeAt !== undefined) patch.closeAt = args.closeAt;
    if (args.startAt !== undefined) patch.startAt = args.startAt;
    if (args.fulfillmentMethod !== undefined) patch.fulfillmentMethod = args.fulfillmentMethod;
    if (args.pickupDetails !== undefined) patch.pickupDetails = args.pickupDetails;
    if (args.feeSantim !== undefined) patch.feeSantim = args.feeSantim;
    if (args.minBidSantim !== undefined) patch.minBidSantim = args.minBidSantim;
    if (args.maxBidSantim !== undefined) patch.maxBidSantim = args.maxBidSantim;
    if (args.antiSnipeWindowMs !== undefined) patch.antiSnipeWindowMs = args.antiSnipeWindowMs;
    if (args.antiSnipeExtendMs !== undefined) patch.antiSnipeExtendMs = args.antiSnipeExtendMs;
    if (args.antiSnipeMaxExtensions !== undefined) {
      patch.antiSnipeMaxExtensions = args.antiSnipeMaxExtensions;
    }
    const result = await updateAuctionConfigRow(ctx as unknown as AuctionCtx, {
      operatorUserId: operator.value.userId,
      auctionId: args.auctionId,
      patch,
      now: Date.now(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true };
  },
});

export const publishAuction = mutation({
  args: { auctionId },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const operator = await requireOperator(ctx);
    if (!operator.ok) return { ok: false, reason: operator.reason };
    const result = await publishAuctionPrimitive(ctx as unknown as AuctionCtx, {
      operatorUserId: operator.value.userId,
      auctionId: args.auctionId,
      now: Date.now(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true };
  },
});

export const openAuctionFn = mutation({
  args: { auctionId },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const operator = await requireOperator(ctx);
    if (!operator.ok) return { ok: false, reason: operator.reason };
    const result = await openAuctionPrimitive(ctx as unknown as AuctionCtx, {
      operatorUserId: operator.value.userId,
      auctionId: args.auctionId,
      now: Date.now(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true };
  },
});

/* ══════════════════════════ Public queries (read-only) ══════════════════════════ */

export const getPublicAuction = query({
  args: { auctionId },
  handler: async (ctx, args) => {
    const auction = await ctx.db.get(args.auctionId);
    if (auction === null) return null;
    return await projectPublic(ctx, auction);
  },
});

export const listPublicAuctions = query({
  args: {
    status: v.union(
      v.literal("SCHEDULED"),
      v.literal("OPEN"),
      v.literal("CLOSED"),
      v.literal("SETTLED"),
    ),
  },
  handler: async (ctx, args) => {
    if (!isPubliclyVisibleStatus(args.status)) return [];
    const rows = await ctx.db
      .query("auctions")
      .withIndex("by_status_closeAt", (q) => q.eq("status", args.status))
      .collect();
    const summaries = [];
    for (const auction of rows) {
      const prize = await ctx.db.get(auction.prizeId);
      if (prize === null) continue;
      summaries.push(
        projectPublicAuctionSummary({
          auction: {
            code: auction.code,
            title: auction.title,
            status: auction.status,
            startAt: auction.startAt,
            closeAt: auction.closeAt,
            fulfillmentMethod: auction.fulfillmentMethod,
            feeSantim: auction.feeSantim,
          },
          prize: { title: prize.title, images: prize.images },
        }),
      );
    }
    return summaries;
  },
});

/**
 * The approved public projections (Backend Schema §18.1), built through
 * the pure module's whitelist builders — no blind-bidding internals
 * (winner, uniqueness, ranking, distribution, lowest-unique) and no
 * operator-only configuration (anti-snipe values, pickupDetails) can be
 * included by construction. `biddingEnded` is a DISPLAY-ONLY derived flag
 * from server time — a query never mutates state.
 */
async function projectPublic(
  ctx: { db: { get: (id: Id<"prizes">) => Promise<{ title: string; images: string[]; fulfillmentMethod: string } | null> } },
  auction: {
    _id: Id<"auctions">;
    code: string;
    title: string;
    description?: string;
    prizeId: Id<"prizes">;
    status: string;
    startAt?: number;
    closeAt: number;
    fulfillmentMethod: string;
    feeSantim?: number;
    minBidSantim?: number;
    maxBidSantim?: number;
  },
) {
  const prize = await ctx.db.get(auction.prizeId);
  const status = auction.status as AuctionStatus;
  const base = {
    auctionId: auction._id,
    biddingEnded: Date.now() >= auction.closeAt,
    ...projectPublicAuctionDetail({
      auction: {
        code: auction.code,
        title: auction.title,
        description: auction.description,
        status,
        startAt: auction.startAt,
        closeAt: auction.closeAt,
        fulfillmentMethod: auction.fulfillmentMethod as FulfillmentMethod,
        feeSantim: auction.feeSantim,
        minBidSantim: auction.minBidSantim,
        maxBidSantim: auction.maxBidSantim,
      },
      prize:
        prize === null
          ? { title: "", images: [] }
          : { title: prize.title, images: prize.images },
    }),
  };
  return base;
}

/* ══════════════════════════ Internal seams ══════════════════════════ */

export const internalSweepOpenScheduled = internalMutation({
  args: {},
  handler: async (ctx) => {
    return sweepOpenScheduled(ctx as unknown as AuctionCtx, { now: Date.now() });
  },
});

export const internalSweepCloseExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    // No finalize hook yet — Phase I composes it. NOT cron-registered.
    return sweepCloseExpired(ctx as unknown as AuctionCtx, { now: Date.now() });
  },
});
