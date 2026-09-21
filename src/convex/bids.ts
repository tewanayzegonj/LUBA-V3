/**
 * LUBA V1 — bidding Convex surface (Phase H).
 *
 * Two client-facing functions, nothing more:
 *
 *  - `placeBid` mutation — resolves the identity server-side (session auth
 *    + fail-closed verified-phone gate via the Phase B/C guards — the client
 *    never asserts an actor), stamps server time (the client clock is
 *    display-only), and delegates to the one transactional submission
 *    primitive. Response shape carries `{ txId, replayed }`-equivalent
 *    fields (`bidId` + `status: "accepted" | "replay"`). Amount is the only
 *    financial input and it is VALIDATED against server-side configuration —
 *    the client never chooses a fee, account, or economic effect.
 *
 *  - `listMyBids` query — the user-owned projection (PRD Q22 frozen shape:
 *    own amount, fee, transactional status, refund status). Ownership is
 *    enforced server-side (bidderId must equal the caller); blind-bidding
 *    internals do not exist in the projection (no uniqueness, ranking,
 *    distribution, other bidders, or live counters — structural blindness,
 *    Backend Schema §9/§18.2).
 *
 *    Own-bid visibility during an OPEN auction is INTENTIONAL, not an
 *    oversight: TRD §19 [FROZEN] restricts live own-bid information to
 *    "transactional status only" and TRD §8 allows the live own-bid list to
 *    show "own amounts + status; nothing else" — the prohibition is on
 *    uniqueness/duplication/winning/ranking/other bids, never on own
 *    amounts. The Q22 shape governs both live and post-close views here.
 *
 * No live bid counter exists (OPEN decision, TRD §19); no public bid query
 * exists at all. No settlement/refund/winner logic lives here (Phase I).
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireVerifiedPhoneUser } from "./guards/auth";
import { checkAndRecordRate } from "./guards/abuse";
import { projectOwnBids, submitBid } from "./financial/bids";

const idempotencyToken = v.string();
const amountSantim = v.number();

export const placeBid = mutation({
  args: {
    auctionId: v.id("auctions"),
    idempotencyToken,
    amountSantim,
  },
  handler: async (ctx, args) => {
    // ── Authenticate + verified phone (fail-closed, server-side) ──
    const authUserId = await getAuthUserId(ctx);
    const guard = await requireVerifiedPhoneUser({
      auth: ctx.auth,
      db: ctx.db,
    });
    if (!guard.ok) {
      return { ok: false as const, status: "refused" as const, reason: guard.reason };
    }
    void authUserId; // identity flows exclusively through the guard

    // ── Server-authoritative time (TRD §17) — the client clock is
    //    display-only and is never accepted as input. ──
    const now = Date.now();

    // ── Generic abuse throttle (mechanism only): one `bid_submit` hit per
    //    attempt, recorded in this same transaction. Thresholds are OPEN —
    //    while unconfigured this is a zero-write no-op. This is generic
    //    throttling ONLY (Backend Schema §16): it is never a product
    //    bid-volume cap, and it runs AFTER the auth gate so an unverified
    //    caller cannot even burn a throttle slot. ──
    const throttle = await checkAndRecordRate(ctx as unknown as Parameters<typeof checkAndRecordRate>[0], {
      subject: "bid_submit",
      subjectId: guard.value.userId,
      now,
    });
    if (!throttle.ok) {
      return { ok: false as const, status: "refused" as const, reason: throttle.reason };
    }

    // ── The one transactional submission path ──
    const result = await submitBid(
      ctx as unknown as Parameters<typeof submitBid>[0],
      {
        auctionId: args.auctionId,
        bidderId: guard.value.userId,
        idempotencyToken: args.idempotencyToken,
        amountSantim: args.amountSantim,
        now,
      },
    );

    if (result.ok) {
      return {
        ok: true as const,
        status: result.status, // "accepted" | "replay" (the replayed flag)
        bidId: result.bidId,
        walletBalanceSantim:
          result.status === "accepted" ? result.walletBalanceSantim : null,
        antiSnipeNewCloseAt: result.antiSnipeNewCloseAt,
      };
    }
    return {
      ok: false as const,
      status: result.status, // "rejected" (frozen reason) | "refused"
      reason: result.reason,
      bidId: result.status === "rejected" ? result.bidId : null,
    };
  },
});

export const listMyBids = query({
  args: { auctionId: v.id("auctions") },
  handler: async (ctx, args) => {
    // Ownership enforced server-side: only the caller's own bid rows are
    // even readable here — IDOR-resistant by construction.
    const authUserId = await getAuthUserId(ctx);
    if (authUserId === null) return [];
    const rows = await ctx.db
      .query("bids")
      .withIndex("by_bidder_auction", (q) =>
        q.eq("bidderId", authUserId).eq("auctionId", args.auctionId),
      )
      .collect();
    // Blind-safe whitelisted projection (amount, fee, status, refundStatus,
    // placedAt) — never uniqueness/ranking/distribution (§18.2).
    return projectOwnBids(rows as unknown as Array<Record<string, unknown>>);
  },
});
