/**
 * LUBA V1 — Convex function surface for prizes and inventory (Phase F).
 *
 * Authorization boundaries (TRD §5/§28, Backend Schema §2/§18.3):
 *  - `createPrize` / `updatePrize` are operator-only PUBLIC mutations: the
 *    actor is resolved server-side from the session via the Phase C
 *    `requireOperator` guard — never from client args — and re-verified
 *    inside the primitive (defense in depth).
 *  - `internalReserveInventory` / `internalCommitReservation` /
 *    `internalResolveReservation` are INTERNAL seams: RESERVE is called by
 *    Phase G auction creation/configuration (operator-gated there), COMMIT
 *    by the Phase I settlement transaction, RELEASE-family resolutions by
 *    the void/no_winner sweeps and cancellation flows. Nothing invokes them
 *    yet — by design.
 *
 * Clients cannot choose inventory outcomes: quantity is validated
 * server-side; `availableCount` is server-owned and never client-supplied;
 * audit attribution is server-derived. No compensating cleanup writes
 * anywhere — refusals precede all writes, throws abort the transaction.
 *
 * OPEN decisions untouched: marketplace listing, auction creation, delivery
 * coverage/pickup vocabulary, fulfillment specifics.
 */
import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOperator } from "./guards/auth";
import type { PrizeDraftInput } from "./domain/inventory";
import {
  createPrizeRow,
  publicPrizeProjection,
  updatePrizeRow,
} from "./inventory/prizes";
import {
  commitReservation,
  reserveInventory,
  resolveReservation,
} from "./inventory/reservations";

/* ── Operator prize management (public, operator-only) ── */

export const createPrize = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    images: v.array(v.string()),
    fulfillmentMethod: v.union(v.literal("delivery"), v.literal("pickup")),
    deliveryCoverage: v.optional(v.string()),
    pickupLocationRef: v.optional(v.string()),
    initialCount: v.number(),
  },
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    if (!operator.ok) return operator;

    const draft: PrizeDraftInput = {
      title: args.title,
      ...(args.description !== undefined ? { description: args.description } : {}),
      images: args.images,
      fulfillmentMethod: args.fulfillmentMethod,
      ...(args.deliveryCoverage !== undefined ? { deliveryCoverage: args.deliveryCoverage } : {}),
      ...(args.pickupLocationRef !== undefined ? { pickupLocationRef: args.pickupLocationRef } : {}),
      initialCount: args.initialCount,
    };
    return createPrizeRow(ctx, { operatorUserId: operator.value.userId, draft });
  },
});

export const updatePrize = mutation({
  args: {
    prizeId: v.id("prizes"),
    /** Whitelist-evaluated patch; inventory fields are structurally rejected. */
    patch: v.record(v.string(), v.any()),
  },
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    if (!operator.ok) return operator;

    return updatePrizeRow(ctx, {
      operatorUserId: operator.value.userId,
      prizeId: args.prizeId,
      patch: args.patch,
    });
  },
});

/**
 * Public-safe prize projection for the caller (Backend Schema §18.1):
 * catalog summary/imagery only. Operator rows (with inventory levels and
 * configuration) are exposed through the Phase M operator console, never
 * here.
 */
export const getPublicPrize = query({
  args: { prizeId: v.id("prizes") },
  handler: async (ctx, args) => {
    const prize = await ctx.db.get(args.prizeId);
    if (prize === null) return null;
    return publicPrizeProjection(prize);
  },
});

/* ── Internal seams (wired by Phases G/I) ── */

export const internalReserveInventory = internalMutation({
  args: {
    operatorUserId: v.id("users"),
    auctionId: v.id("auctions"),
    prizeId: v.id("prizes"),
    quantity: v.number(),
  },
  handler: async (ctx, args) =>
    reserveInventory(ctx, {
      operatorUserId: args.operatorUserId,
      auctionId: args.auctionId,
      prizeId: args.prizeId,
      quantity: args.quantity,
    }),
});

export const internalCommitReservation = internalMutation({
  args: { reservationId: v.id("inventoryReservations") },
  handler: async (ctx, args) =>
    commitReservation(ctx, { reservationId: args.reservationId as Id<"inventoryReservations"> }),
});

export const internalResolveReservation = internalMutation({
  args: {
    reservationId: v.id("inventoryReservations"),
    resolution: v.union(
      v.literal("void"),
      v.literal("no_winner"),
      v.literal("cancel_before_open"),
    ),
    operatorUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) =>
    resolveReservation(ctx, {
      reservationId: args.reservationId as Id<"inventoryReservations">,
      resolution: args.resolution,
      operatorUserId:
        args.operatorUserId !== undefined
          ? (args.operatorUserId as Id<"users">)
          : null,
    }),
});
