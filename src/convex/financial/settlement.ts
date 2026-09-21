/**
 * LUBA V1 — settlement orchestration (Phase I, frozen plan §6–§11).
 *
 * Server-side primitives composed by the internal/public surfaces:
 *
 *   - `finalizeAuction` — the Phase I finalization hook for the Phase G
 *     seam: streaming singleton-walk over `by_auction_status_amount`
 *     (ACCEPTED-only, amount-ascending), conclusive ONLY at exhaustion
 *     (result + finalAcceptedBidCount + winningBidId commit together),
 *     resumable via the `settlementCampaigns` walk state when a pass
 *     exceeds the per-tx page budget (deferred ⇒ the auction stays OPEN —
 *     the CLOSED patch is skipped by the seam — until the close sweep
 *     resumes). WINNER ⇒ deadline stamped + settlementRecords(pending) +
 *     inventory stays held (fail-closed on unset deadline). NO_WINNER ⇒
 *     bid_refunds campaign + inventory RELEASE.
 *
 *   - `settleWinner` — public settle path: verified-winner guards, wallet
 *     debit of the server-read winning amount (kind "settlement", distinct
 *     class), inventory COMMIT, settlementRecords → paid, CLOSED → SETTLED,
 *     audits, user-bound idempotency.
 *
 *   - `sweepVoidExpiredSettlements` — deadline void: voided + RELEASE +
 *     bid_refunds campaign (incl. the defaulting winner). No runner-up.
 *
 *   - `processRefundChunk` — real `.paginate()` continuation; per-bid
 *     engine per bid; terminalization ONLY on the final page's
 *     `isDone === true` (campaign complete + CLOSED → SETTLED + audit in
 *     the same transaction). A non-final page MUST NOT settle.
 *
 *   - `sweepStalledCampaigns` — backstop: re-kicks in_progress campaigns
 *     only (determination via the close seam; refunds via self-schedule).
 *
 * All workers are identity-free: idempotency keys derive from system-owned
 * data; audits are system-attributed. Every refusal precedes every write;
 * any throw aborts the surrounding Convex transaction (zero partial state).
 */
import type { Id } from "../_generated/dataModel";

import type { CloseFinalization, CloseFinalizationResult } from "../auction/lifecycle";
import { closeAuction } from "../auction/lifecycle";
import {
  concludeWalk,
  initialWalkState,
  walkPage,
  type WalkState,
} from "../domain/winner";
import {
  evaluateCampaignCreation,
  evaluateCampaignValidity,
  evaluateSettleEligibility,
  evaluateSettledTransition,
  evaluateTerminalization,
  evaluateVoidEligibility,
} from "../domain/settlement";
import { getSettlementDeadlineMs, DETERMINATION_PAGE_BUDGET, REFUND_CHUNK_SIZE } from "../settlementConfig";
import {
  checkIdempotencyKey,
  commitIdempotencyKey,
  decodeOutcome,
  deriveIdempotencyKey,
  fingerprintRequest,
  type IdempotencyCtx,
} from "../guards/idempotency";
import { recordAuditEvent, type AuditCtx } from "../guards/audit";
import { commitReservation, resolveReservation, type ReservationCtx } from "../inventory/reservations";
import { postWalletTransaction, type WalletCtx } from "./wallet";
import { refundBid, type RefundCtx } from "./refunds";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type SettlementRow = Record<string, unknown> & { _id: string };

/** Chainable builder for indexed reads (eq/lt chains). */
export type SettlementIndexBuilder = {
  eq: (field: string, value: unknown) => SettlementIndexBuilder;
  lt: (field: string, value: unknown) => SettlementIndexBuilder;
};

export type PaginatedPage = {
  page: SettlementRow[];
  isDone: boolean;
  continueCursor: string;
};

type SettlementDb = {
  get: (id: string) => Promise<SettlementRow | null>;
  insert: (table: string, doc: Record<string, unknown>) => Promise<string>;
  patch: (id: string, doc: Record<string, unknown>) => Promise<void>;
  query: (table: string) => {
    withIndex: (
      name: string,
      fn: (q: SettlementIndexBuilder) => SettlementIndexBuilder,
    ) => {
      unique: () => Promise<SettlementRow | null>;
      collect: () => Promise<SettlementRow[]>;
      order: (dir: "asc" | "desc") => {
        paginate: (opts: { cursor?: string; numItems: number }) => Promise<PaginatedPage>;
      };
    };
  };
};

export type ScheduleNextChunk = (campaignId: Id<"settlementCampaigns">) => Promise<void>;

export type SettlementCtx = SettlementDb &
  IdempotencyCtx &
  AuditCtx &
  WalletCtx &
  ReservationCtx &
  RefundCtx & {
    /** Real scheduler on Convex; test fakes may record calls. */
    scheduleNextRefundChunk: ScheduleNextChunk;
  };

/* ══════════════════ Finalization hook (Phase G seam composition) ══════════════════ */

type AuctionRowShape = {
  _id: string;
  status: string;
  closeAt: number;
  settlementDeadline?: number;
  code?: string;
};

type WalkRowShape = {
  _id: string;
  auctionId?: string;
  status: string;
  pageCursor?: string;
  currentAmount?: number;
  currentRunCount?: number;
  currentCandidateBidId?: string;
  winnerBidId?: string;
  acceptedCount?: number;
  processedCount?: number;
  trigger?: "no_winner" | "settlement_void";
  kind: "winner_determination" | "bid_refunds";
};

const CAMPAIGN_ROW_BASE = {
  processedCount: 0,
};

async function loadCampaign(
  db: SettlementDb,
  auctionId: string,
  kind: "winner_determination" | "bid_refunds",
): Promise<WalkRowShape | null> {
  return (await db
    .query("settlementCampaigns")
    .withIndex("by_auction_kind", (q) => q.eq("auctionId", auctionId).eq("kind", kind))
    .unique()) as WalkRowShape | null;
}

/**
 * Create a campaign row behind the frozen transactional uniqueness guard:
 * the `(auctionId, kind)` index is a LOOKUP, not a constraint — check then
 * insert; concurrent creators contend on the index range (Convex OCC) and
 * the loser restarts into `replay` (zero effect, exactly one campaign).
 */
async function createCampaignGuarded(
  ctx: SettlementCtx,
  input: {
    auctionId: Id<"auctions">;
    kind: "winner_determination" | "bid_refunds";
    trigger?: "no_winner" | "settlement_void";
    now: number;
    walkState?: WalkState;
    pageCursor?: string;
  },
): Promise<Id<"settlementCampaigns">> {
  const db = ctx.db as SettlementDb;

  const validity = evaluateCampaignValidity({ kind: input.kind, trigger: input.trigger });
  if (!validity.ok) throw new Error(`campaign validity refused: ${validity.reason}`);

  const existing = await loadCampaign(db, input.auctionId, input.kind);
  const decision = evaluateCampaignCreation(
    existing === null
      ? null
      : { status: existing.status, trigger: existing.trigger, kind: input.kind },
  );
  if (decision.action === "replay") {
    // Existing row wins — replay onto it (the OCC-race loser's landing spot).
    return existing!._id as Id<"settlementCampaigns">;
  }

  const doc: Record<string, unknown> = {
    ...CAMPAIGN_ROW_BASE,
    auctionId: input.auctionId,
    kind: input.kind,
    status: "in_progress",
    createdAt: input.now,
  };
  if (input.trigger !== undefined) doc.trigger = input.trigger;
  if (input.walkState !== undefined) {
    doc.pageCursor = input.pageCursor;
    doc.currentAmount = input.walkState.currentAmount ?? undefined;
    doc.currentRunCount = input.walkState.currentRunCount;
    doc.currentCandidateBidId = input.walkState.currentCandidateBidId ?? undefined;
    doc.winnerBidId = input.walkState.winnerBidId ?? undefined;
    doc.acceptedCount = input.walkState.acceptedCount;
    doc.processedCount = input.walkState.acceptedCount;
  }
  return (await db.insert("settlementCampaigns", doc)) as Id<"settlementCampaigns">;
}

function stateFromRow(row: WalkRowShape): WalkState {
  return {
    currentAmount: row.currentAmount ?? null,
    currentRunCount: row.currentRunCount ?? 0,
    currentCandidateBidId: (row.currentCandidateBidId as Id<"bids">) ?? null,
    winnerBidId: (row.winnerBidId as Id<"bids">) ?? null,
    acceptedCount: row.acceptedCount ?? 0,
  };
}

/**
 * Conclusive determination: read the winning bid row (server truth for the
 * amount), insert `auctionResults` (unique-guarded) with result + winning
 * bid + amount + authoritative count together, then run the post-result
 * path (NO_WINNER ⇒ refunds campaign + RELEASE; WINNER ⇒ deadline +
 * pending record, inventory stays held). Fails closed on an unset deadline.
 */
async function concludeDetermination(
  ctx: SettlementCtx,
  input: {
    auctionId: Id<"auctions">;
    auction: AuctionRowShape;
    state: WalkState;
    campaignId: Id<"settlementCampaigns"> | null;
    now: number;
  },
): Promise<CloseFinalizationResult> {
  const db = ctx.db as SettlementDb;
  const conclusion = concludeWalk(input.state);

  // Exactly-once result guard: the by_auction unique lookup (re-close racing
  // the hook lands here after OCC restart).
  const existingResult = await db
    .query("auctionResults")
    .withIndex("by_auction", (q) => q.eq("auctionId", input.auctionId))
    .unique();
  if (existingResult !== null) {
    if (input.campaignId !== null) {
      await db.patch(input.campaignId, { status: "complete", completedAt: input.now });
    }
    const prior = existingResult.result as string;
    return { result: prior as "WINNER" | "NO_WINNER" };
  }

  if (conclusion.result === "WINNER") {
    // Winner amount read from the authoritative bid row — never computed.
    const winningBid = await db.get(conclusion.winnerBidId);
    if (winningBid === null) throw new Error("winning bid row disappeared mid-walk");

    await db.insert("auctionResults", {
      auctionId: input.auctionId,
      result: "WINNER",
      winningBidId: conclusion.winnerBidId,
      winningAmountSantim: winningBid.amountSantim,
      finalAcceptedBidCount: input.state.acceptedCount,
      closeTime: input.auction.closeAt,
      determinedAt: input.now,
    });

    // O1 fail-closed: an unset deadline policy refuses WINNER finalization
    // — the throw aborts the whole close transaction (no result-less
    // CLOSED auction can ever commit; the walk state was not persisted as
    // a campaign on this conclusive pass).
    const deadlineMs = getSettlementDeadlineMs();
    if (deadlineMs === null) {
      throw new Error("settlement_deadline_unconfigured");
    }
    await db.patch(input.auctionId, {
      settlementDeadline: input.now + deadlineMs,
    });
    await db.insert("settlementRecords", {
      auctionId: input.auctionId,
      winnerId: winningBid.bidderId,
      amountSantim: winningBid.amountSantim,
      status: "pending",
      deadline: input.now + deadlineMs,
      idempotencyKey: `luba:idem:settlement:${input.auctionId}`,
    });
    // Inventory stays HELD (frozen): committed only at successful settle.
    return { result: "WINNER" };
  }

  // NO_WINNER: result + refunds campaign + inventory RELEASE, one tx.
  await db.insert("auctionResults", {
    auctionId: input.auctionId,
    result: "NO_WINNER",
    finalAcceptedBidCount: input.state.acceptedCount,
    closeTime: input.auction.closeAt,
    determinedAt: input.now,
  });
  await createCampaignGuarded(ctx, {
    auctionId: input.auctionId,
    kind: "bid_refunds",
    trigger: "no_winner",
    now: input.now,
  });
  const reservation = await db
    .query("inventoryReservations")
    .withIndex("by_auction", (q) => q.eq("auctionId", input.auctionId))
    .unique();
  if (reservation !== null) {
    const released = await resolveReservation(ctx, {
      reservationId: reservation._id as Id<"inventoryReservations">,
      resolution: "no_winner",
      operatorUserId: null,
    });
    if (!released.ok) throw new Error(`inventory release failed: ${released.reason}`);
  }
  return { result: "NO_WINNER" };
}

/**
 * The Phase I finalization hook — composed into `closeAuction` by the
 * surfaces. Streams the walk; defers (with full persisted state) when a
 * pass exhausts the per-tx page budget before concluding.
 */
export function createFinalizationHook(): CloseFinalization {
  return async (ctx, input): Promise<CloseFinalizationResult> => {
    const sctx = ctx as unknown as SettlementCtx;
    const db = sctx.db as SettlementDb;
    const auction = (await db.get(input.auctionId)) as AuctionRowShape | null;
    if (auction === null) throw new Error("finalize hook: auction not found");

    const campaign = await loadCampaign(db, input.auctionId, "winner_determination");

    let state: WalkState;
    let cursor: string | undefined;
    let campaignId: Id<"settlementCampaigns"> | null = null;

    if (campaign !== null && campaign.status === "in_progress") {
      // Resume the interrupted walk from the exact persisted state — no
      // recomputation; the post-close accepted set is immutable.
      state = stateFromRow(campaign);
      cursor = campaign.pageCursor;
      campaignId = campaign._id as Id<"settlementCampaigns">;
    } else {
      // Fresh walk (or a completed campaign whose result row exists — the
      // conclusion guard below replays it).
      state = initialWalkState();
    }

    const page = await db
      .query("bids")
      .withIndex("by_auction_status_amount", (q) =>
        q.eq("auctionId", input.auctionId).eq("status", "ACCEPTED"),
      )
      .order("asc")
      .paginate({ cursor, numItems: DETERMINATION_PAGE_BUDGET });

    // The walk consumes (bidId, amountSantim) index entries in ascending
    // amount order — map the bid rows onto the pure state machine's input.
    const walked = walkPage(
      state,
      page.page.map((row) => ({
        bidId: row._id as Id<"bids">,
        amountSantim: row.amountSantim as number,
      })),
    );
    state = walked.state;

    if (!page.isDone) {
      // Budget exceeded before exhaustion ⇒ persist/advance the campaign
      // (full walk state + opaque cursor) and defer. The seam skips the
      // CLOSED patch: the auction stays OPEN (bids refused by server time)
      // until the close sweep resumes.
      if (campaignId === null) {
        campaignId = await createCampaignGuarded(sctx, {
          auctionId: input.auctionId,
          kind: "winner_determination",
          now: input.now,
          walkState: state,
          pageCursor: page.continueCursor,
        });
      } else {
        await db.patch(campaignId, {
          pageCursor: page.continueCursor,
          currentAmount: state.currentAmount ?? undefined,
          currentRunCount: state.currentRunCount,
          currentCandidateBidId: state.currentCandidateBidId ?? undefined,
          winnerBidId: state.winnerBidId ?? undefined,
          acceptedCount: state.acceptedCount,
          processedCount: state.acceptedCount,
        });
      }
      return { deferred: true, reason: "determination_deferred" };
    }

    // Exhaustion ⇒ conclusive: count complete, candidate settled.
    return concludeDetermination(sctx, {
      auctionId: input.auctionId,
      auction,
      state,
      campaignId,
      now: input.now,
    });
  };
}

/* ══════════════════ Winner settlement (public path primitive) ══════════════════ */

export type SettleWinnerInput = {
  auctionId: Id<"auctions">;
  /** Server-resolved caller (requireVerifiedPhoneUser at the surface). */
  callerId: Id<"users">;
  phoneVerified: boolean;
  now: number;
};

export type SettleWinnerResult =
  | { ok: true; status: "settled"; entryId: Id<"ledgerEntries">; balanceSantim: number }
  | { ok: true; status: "replay"; entryId: Id<"ledgerEntries"> | null }
  | { ok: false; status: "refused"; reason: string };

export async function settleWinner(
  ctx: SettlementCtx,
  input: SettleWinnerInput,
): Promise<SettleWinnerResult> {
  const db = ctx.db as SettlementDb;

  const auction = (await db.get(input.auctionId)) as AuctionRowShape | null;
  const result = await db
    .query("auctionResults")
    .withIndex("by_auction", (q) => q.eq("auctionId", input.auctionId))
    .unique();
  const record = await db
    .query("settlementRecords")
    .withIndex("by_auction", (q) => q.eq("auctionId", input.auctionId))
    .unique();

  // User-bound idempotency (the one auth-derived key in Phase I — the
  // settle path IS user-facing). Checked BEFORE the guards: a retry of the
  // already-settled request must replay the original outcome even though
  // the settlement record is now `paid` (the state guard would refuse it).
  const key = deriveIdempotencyKey({
    op: "settlement",
    userId: input.callerId,
    clientToken: `settle:${input.auctionId}`,
  });
  const fingerprint = fingerprintRequest({ auctionId: input.auctionId });
  const checked = await checkIdempotencyKey(ctx, { key, fingerprint });
  if (checked.status === "replay") {
    const stored = decodeOutcome(checked.outcome);
    let entryId: Id<"ledgerEntries"> | null = null;
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored.outcome) as { ledgerEntryId?: string };
        entryId = (parsed.ledgerEntryId ?? null) as Id<"ledgerEntries"> | null;
      } catch {
        entryId = null;
      }
    }
    return { ok: true, status: "replay", entryId };
  }
  if (checked.status === "conflict") {
    return { ok: false, status: "refused", reason: "idempotency_conflict" };
  }

  const guard = evaluateSettleEligibility({
    auctionFound: auction !== null,
    auctionStatus: auction?.status ?? "",
    result: result !== null ? (result.result as string) : null,
    winningBidderId: (record?.winnerId as string) ?? "",
    callerId: input.callerId,
    phoneVerified: input.phoneVerified,
    settlementDeadline: auction?.settlementDeadline ?? null,
    settlementRecordStatus: record !== null ? (record.status as string) : null,
    now: input.now,
  });
  if (!guard.ok) return { ok: false, status: "refused", reason: guard.reason };

  // Amount ONLY from auctionResults (server truth) — never client-supplied.
  const amountSantim = result!.winningAmountSantim as number;

  // ── Wallet debit (kind "settlement" — distinct ledger class) ──
  const posted = await postWalletTransaction(ctx, {
    kind: "settlement",
    refType: "auction",
    refId: input.auctionId,
    walletLegs: [{ userId: input.callerId, deltaSantim: -amountSantim }],
    counterpartPostings: [
      {
        account: "platform:settlement_revenue",
        direction: "credit",
        amountSantim,
      },
    ],
    ownerUserId: input.callerId,
    idempotencyToken: key,
    idempotencyOp: "settlement",
  });
  if (!posted.ok || posted.status !== "posted") {
    if (posted.ok && posted.status === "replay") {
      return { ok: true, status: "replay", entryId: posted.entryId };
    }
    return {
      ok: false,
      status: "refused",
      reason: posted.ok ? (posted as { reason?: string }).reason ?? "wallet_refused" : (posted as { reason: string }).reason,
    };
  }

  // ── Inventory COMMIT (winner's entitlement, same transaction) ──
  const reservation = await db
    .query("inventoryReservations")
    .withIndex("by_auction", (q) => q.eq("auctionId", input.auctionId))
    .unique();
  if (reservation !== null) {
    const committed = await commitReservation(ctx, {
      reservationId: reservation._id as Id<"inventoryReservations">,
    });
    if (!committed.ok) throw new Error(`inventory commit failed: ${committed.reason}`);
  }

  // ── Terminal transition: settlementRecords paid + CLOSED → SETTLED ──
  await db.patch(record!._id, { status: "paid", paidAt: input.now });
  const transition = evaluateSettledTransition(auction!.status);
  if (!transition.ok) throw new Error(`settled transition refused: ${transition.reason}`);
  await db.patch(input.auctionId, { status: "SETTLED" });

  // ── Audits + idempotency commit — same transaction ──
  await recordAuditEvent(ctx, {
    actorId: input.callerId,
    actorRole: "user",
    action: "settlement.completed",
    entityType: "settlementRecords",
    entityId: record!._id,
    idempotencyKey: key,
    amountSantim,
    meta: {
      auctionId: input.auctionId,
      ledgerEntryId: posted.entryId,
      reservationCommitted: reservation !== null,
    },
  });
  await recordAuditEvent(ctx, {
    actorId: input.callerId,
    actorRole: "user",
    action: "auction.settled",
    entityType: "auctions",
    entityId: input.auctionId,
    idempotencyKey: key,
    meta: { via: "winner_settlement" },
  });
  await commitIdempotencyKey(ctx, {
    key,
    op: "settlement",
    userId: input.callerId,
    fingerprint,
    refType: "settlementRecords",
    refId: record!._id,
    outcome: JSON.stringify({ ledgerEntryId: posted.entryId, status: "settled" }),
  });

  const balanceSantim =
    posted.balances.find((b) => b.userId === input.callerId)?.availableSantim ?? 0;
  return { ok: true, status: "settled", entryId: posted.entryId, balanceSantim };
}

/* ══════════════════ Deadline void sweep ══════════════════ */

export type SweepVoidResult = { voided: number; scanned: number };

export async function sweepVoidExpiredSettlements(
  ctx: SettlementCtx,
  input: { now: number },
): Promise<SweepVoidResult> {
  const db = ctx.db as SettlementDb;
  const expired = (await db
    .query("auctions")
    .withIndex("by_status_deadline", (q) =>
      q.eq("status", "CLOSED").lt("settlementDeadline", input.now),
    )
    .collect()) as AuctionRowShape[];

  let voided = 0;
  for (const auction of expired) {
    const record = await db
      .query("settlementRecords")
      .withIndex("by_auction", (q) => q.eq("auctionId", auction._id))
      .unique();
    const guard = evaluateVoidEligibility({
      auctionFound: true,
      auctionStatus: auction.status,
      settlementRecordStatus: record !== null ? (record.status as string) : null,
      settlementDeadline: auction.settlementDeadline ?? null,
      now: input.now,
    });
    if (!guard.ok) continue; // guarded re-fire / settle-race loser replays here

    // 1. voided + result amendment (frozen §8: "result becomes NO_WINNER —
    // terminal settlement outcome") 2. RELEASE 3. refunds campaign (incl.
    // the defaulting winner). No runner-up, no re-award, no override.
    await db.patch(record!._id, { status: "voided", voidedAt: input.now });
    // Amend the stored result to its terminal NO_WINNER outcome (the row
    // exists — finalization committed it; absence is an invariant failure).
    const storedResult = await db
      .query("auctionResults")
      .withIndex("by_auction", (q) => q.eq("auctionId", auction._id))
      .unique();
    if (storedResult === null) throw new Error("void sweep: auction result missing");
    await db.patch(storedResult._id, { result: "NO_WINNER" });
    const reservation = await db
      .query("inventoryReservations")
      .withIndex("by_auction", (q) => q.eq("auctionId", auction._id))
      .unique();
    if (reservation !== null) {
      const released = await resolveReservation(ctx, {
        reservationId: reservation._id as Id<"inventoryReservations">,
        resolution: "void",
        operatorUserId: null,
      });
      if (!released.ok) throw new Error(`inventory release failed: ${released.reason}`);
    }
    await createCampaignGuarded(ctx, {
      auctionId: auction._id as Id<"auctions">,
      kind: "bid_refunds",
      trigger: "settlement_void",
      now: input.now,
    });
    await recordAuditEvent(ctx, {
      actorId: null,
      actorRole: "system",
      action: "settlement.voided",
      entityType: "settlementRecords",
      entityId: record!._id,
      amountSantim: record!.amountSantim as number,
      meta: { auctionId: auction._id, deadlineExpired: true },
    });
    voided += 1;
  }
  return { voided, scanned: expired.length };
}

/* ══════════════════ Refund chunk worker (isDone-gated terminalization) ══════════════════ */

export type ProcessRefundChunkResult =
  | { ok: true; status: "continued"; processed: number; isDone: boolean }
  | { ok: true; status: "settled"; processed: number }
  | { ok: false; status: "refused"; reason: string };

export async function processRefundChunk(
  ctx: SettlementCtx,
  input: { campaignId: Id<"settlementCampaigns">; now: number },
): Promise<ProcessRefundChunkResult> {
  const db = ctx.db as SettlementDb;

  const campaign = (await db.get(input.campaignId)) as WalkRowShape | null;
  if (campaign === null) return { ok: false, status: "refused", reason: "campaign_not_found" };
  if (campaign.kind !== "bid_refunds") {
    return { ok: false, status: "refused", reason: "wrong_campaign_kind" };
  }
  if (campaign.status !== "in_progress") {
    // Completed campaigns are never reprocessed (backstop no-op).
    return { ok: true, status: "continued", processed: 0, isDone: true };
  }
  const auctionId = (await db.get(input.campaignId)) !== null
    ? ((await db.get((campaign as unknown as { auctionId: string }).auctionId)) as AuctionRowShape | null)
    : null;
  if (auctionId === null) return { ok: false, status: "refused", reason: "auction_not_found" };

  // Real pagination over the immutable post-close ACCEPTED set; the opaque
  // cursor is passed and stored verbatim — never decoded, never an id.
  const page = await db
    .query("bids")
    .withIndex("by_auction_status", (q) =>
      q.eq("auctionId", (campaign as unknown as { auctionId: string }).auctionId).eq("status", "ACCEPTED"),
    )
    .order("asc")
    .paginate({ cursor: campaign.pageCursor, numItems: REFUND_CHUNK_SIZE });

  // Per-bid engine per bid (per-bid atomicity mandatory; batch atomicity
  // deliberately not recreated). Already-refunded bids replay as no-ops.
  let processed = 0;
  for (const bid of page.page) {
    const outcome = await refundBid(ctx, {
      auctionId: (campaign as unknown as { auctionId: string }).auctionId as Id<"auctions">,
      bidId: bid._id as Id<"bids">,
      now: input.now,
    });
    if (outcome.ok) processed += 1;
    else if (outcome.reason === "not_accepted" || outcome.reason === "invalid_fee") {
      throw new Error(`refund engine refused bid ${bid._id}: ${outcome.reason}`);
    }
  }

  // Terminalization decision — ONLY the final page may settle.
  const decision = evaluateTerminalization({
    isDone: page.isDone,
    campaignStatus: campaign.status,
  });

  if (decision.action === "settle") {
    // One transaction: final-page refunds (above) + campaign complete +
    // CLOSED → SETTLED + settlement audit. The post-close accepted set is
    // immutable (bid path refuses too_late), so isDone means the entire
    // authoritative accepted-bid set has been traversed and every bid in
    // it completed the per-bid engine (this page) or an earlier page.
    await db.patch(input.campaignId, {
      status: "complete",
      completedAt: input.now,
      pageCursor: page.continueCursor,
      processedCount: (campaign.processedCount ?? 0) + processed,
    });
    const transition = evaluateSettledTransition(auctionId.status);
    if (!transition.ok) throw new Error(`settled transition refused: ${transition.reason}`);
    await db.patch(auctionId._id, { status: "SETTLED" });
    await recordAuditEvent(ctx, {
      actorId: null,
      actorRole: "system",
      action: "auction.settled",
      entityType: "auctions",
      entityId: auctionId._id,
      meta: {
        via: "refund_campaign",
        trigger: campaign.trigger ?? null,
        refundsProcessed: (campaign.processedCount ?? 0) + processed,
      },
    });
    return { ok: true, status: "settled", processed };
  }

  // Non-final page: advance cursor + count; self-schedule the next chunk.
  await db.patch(input.campaignId, {
    pageCursor: page.continueCursor,
    processedCount: (campaign.processedCount ?? 0) + processed,
  });
  await ctx.scheduleNextRefundChunk(input.campaignId);
  return { ok: true, status: "continued", processed, isDone: page.isDone };
}

/* ══════════════════ Campaign backstop (re-kick in_progress only) ══════════════════ */

export type SweepStalledResult = { requeued: number; resumed: number };

export async function sweepStalledCampaigns(
  ctx: SettlementCtx,
  input: { now: number },
): Promise<SweepStalledResult> {
  const db = ctx.db as SettlementDb;
  const stalled = (await db
    .query("settlementCampaigns")
    .withIndex("by_status", (q) => q.eq("status", "in_progress"))
    .collect()) as unknown as WalkRowShape[];

  let requeued = 0;
  let resumed = 0;
  for (const campaign of stalled) {
    if (campaign.kind === "bid_refunds") {
      await ctx.scheduleNextRefundChunk(campaign._id as Id<"settlementCampaigns">);
      requeued += 1;
    } else {
      // Determination campaigns resume through the close seam: a close call
      // on the still-OPEN auction resumes the walk (or replays if it
      // already concluded).
      const outcome = await closeAuction(ctx as unknown as Parameters<typeof closeAuction>[0], {
        auctionId: campaign.auctionId as Id<"auctions">,
        now: input.now,
        finalize: createFinalizationHook(),
      });
      if (outcome.ok) resumed += 1;
    }
  }
  return { requeued, resumed };
}
