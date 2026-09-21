/**
 * LUBA V1 — server-side auction lifecycle primitives (Phase G).
 *
 * The FROZEN lifecycle (TRD §9): DRAFT → SCHEDULED → OPEN → CLOSED →
 * SETTLED — transitions only via guarded mutations that check state and
 * SERVER time inside the transaction; the Phase B `rules.ts` state machine
 * is composed, never redefined. No CLOSING state exists.
 *
 * Guarantees:
 *  - Server-authoritative time (TRD §17): every guard evaluates the `now`
 *    passed by the Convex surface (`Date.now()`) — clients never supply a
 *    decision time; client clocks are display-only.
 *  - Inventory publish gate (TRD §12): an auction cannot reach SCHEDULED
 *    or OPEN without an ACTIVE `reserved` reservation — verified
 *    server-side in-transaction; clients cannot bypass RESERVE.
 *  - Idempotency by conditional state (TRD §16): re-publishing an already
 *    SCHEDULED auction with identical intent replays with zero effect;
 *    transitions from later states refuse; concurrent attempts serialize
 *    on the auction row under Convex OCC.
 *  - Queries never mutate (TRD §9): display-only derived status lives in
 *    the pure module; all transitions happen here, inside mutations.
 *
 * Finalization seam (TRD §9/§11): `closeAuction` accepts the Phase I
 * composition hook and invokes finalization BEFORE committing CLOSED —
 * the status patch and `resultDeterminedAt` stamp live in the same Convex
 * transaction as the determination, so CLOSED commits only after winner
 * determination succeeds (a finalize throw propagates and aborts
 * everything). This preserves the TRD meaning of CLOSED: bidding ended +
 * result determined — a result-less CLOSED auction does not exist in the
 * frozen model. WINNER ⇒ settlement pending (inventory stays held);
 * NO_WINNER ⇒ release + refunds + SETTLED, all decided in-transaction.
 *
 * Backstop registration: the open sweep is cron-registered now; the close
 * backstop/settlement path is deliberately NOT registered in Phase G, and
 * Phase I MUST register it in crons.json with its finalization hook
 * composed — until then an OPEN auction past close simply waits for
 * Phase I's sweep rather than ever committing a result-less CLOSED state.
 *
 * Anti-snipe (TRD §18): infrastructure only. All three parameters are
 * OPEN — unset ⇒ inactive. When configured, the extension applies from
 * server time, mutates the authoritative closeAt atomically, is bounded by
 * the configured maximum, and is audited. No caller exists yet — the Phase
 * H bid transaction composes this inside its own mutation.
 */
import type { Id } from "../_generated/dataModel";

import {
  evaluateAntiSnipeExtension,
  evaluateCloseEligibility,
  evaluateOpenEligibility,
  evaluatePublishEligibility,
  evaluateSweepOpenEligibility,
} from "../domain/auctions";
import { requireAuctionTransition } from "../domain/rules";
import { recordAuditEvent } from "../guards/audit";
import { verifyOperatorRow } from "../inventory/prizes";
import type { AuctionRow, AuctionCtx } from "./create";

type ReservationRow = { status: string };

type LifecycleDb = {
  get: (id: Id<"auctions"> | Id<"users">) => Promise<AuctionRow | { role?: string } | null>;
  patch: (id: Id<"auctions">, doc: Record<string, unknown>) => Promise<void>;
  query: (table: "inventoryReservations" | "auctions") => {
    withIndex: (
      name: "by_auction" | "by_status_closeAt",
      fn: (q: {
        eq: (field: string, value: unknown) => unknown;
      }) => unknown,
    ) => { collect: () => Promise<Record<string, unknown>[]> };
  };
};

/** The ACTIVE inventory reservation backing an auction, if any. */
async function activeReservation(
  ctx: AuctionCtx,
  auctionId: Id<"auctions">,
): Promise<boolean> {
  const db = ctx.db as LifecycleDb;
  const rows = (await db
    .query("inventoryReservations")
    .withIndex("by_auction", (q) => q.eq("auctionId", auctionId))
    .collect()) as ReservationRow[];
  return rows.some((row) => row.status === "reserved");
}

/* ══════════════════════════ PUBLISH (DRAFT → SCHEDULED) ══════════════════════════ */

export type PublishAuctionInput = {
  operatorUserId: Id<"users">;
  auctionId: Id<"auctions">;
  now: number;
};

export type PublishAuctionResult =
  | { ok: true; auctionId: Id<"auctions">; replayed: boolean }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "auction_not_found"
        | "illegal_transition"
        | "reservation_required";
    };

/**
 * Publish: DRAFT → SCHEDULED. Operator-only. The publish path verifies the
 * inventory reservation server-side (TRD §12 FROZEN) — an auction can
 * never be published on inventory it does not hold. Idempotent: an already
 * SCHEDULED auction replays with zero effect.
 */
export async function publishAuction(
  ctx: AuctionCtx,
  input: PublishAuctionInput,
): Promise<PublishAuctionResult> {
  const db = ctx.db as LifecycleDb;

  const operator = await verifyOperatorRow(ctx, input.operatorUserId);
  if (!operator.ok) return { ok: false, reason: "not_authorized" };

  const auction = (await db.get(input.auctionId)) as AuctionRow | null;
  if (auction === null) return { ok: false, reason: "auction_not_found" };
  if (auction.status === "SCHEDULED") {
    return { ok: true, auctionId: auction._id, replayed: true };
  }

  const eligibility = evaluatePublishEligibility(auction.status);
  if (!eligibility.ok) return { ok: false, reason: "illegal_transition" };

  // INVENTORY GATE — server-side, in-transaction (TRD §12 FROZEN).
  if (!(await activeReservation(ctx, input.auctionId))) {
    return { ok: false, reason: "reservation_required" };
  }

  await db.patch(input.auctionId, { status: "SCHEDULED" });

  await recordAuditEvent(ctx, {
    actorId: operator.operatorUserId,
    actorRole: "operator",
    action: "auction.scheduled",
    entityType: "auctions",
    entityId: input.auctionId,
    meta: { code: auction.code },
  });

  return { ok: true, auctionId: input.auctionId, replayed: false };
}

/* ══════════════════════════ OPEN (SCHEDULED → OPEN) ══════════════════════════ */

export type OpenAuctionInput = {
  /** Operator for manual open; null for the scheduled backstop sweep. */
  operatorUserId: Id<"users"> | null;
  auctionId: Id<"auctions">;
  /** Server clock (TRD §17). */
  now: number;
};

export type OpenAuctionResult =
  | { ok: true; auctionId: Id<"auctions">; replayed: boolean }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "auction_not_found"
        | "illegal_transition"
        | "too_late"
        | "reservation_required";
    };

/**
 * Open: SCHEDULED → OPEN. Operator manual open ("when appropriate", TRD §9)
 * or the scheduled backstop (system). Manual open ignores startAt but can
 * never open at/after the authoritative close time. The inventory gate
 * re-verifies in-transaction. Idempotent by state.
 */
export async function openAuction(
  ctx: AuctionCtx,
  input: OpenAuctionInput,
): Promise<OpenAuctionResult> {
  const db = ctx.db as LifecycleDb;

  let actorRole: "operator" | "system" = "system";
  let actorId: Id<"users"> | null = null;
  if (input.operatorUserId !== null) {
    const operator = await verifyOperatorRow(ctx, input.operatorUserId);
    if (!operator.ok) return { ok: false, reason: "not_authorized" };
    actorRole = "operator";
    actorId = operator.operatorUserId;
  }

  const auction = (await db.get(input.auctionId)) as AuctionRow | null;
  if (auction === null) return { ok: false, reason: "auction_not_found" };
  if (auction.status === "OPEN") {
    return { ok: true, auctionId: auction._id, replayed: true };
  }

  const eligibility = evaluateOpenEligibility({
    status: auction.status,
    closeAt: auction.closeAt,
    now: input.now,
  });
  if (!eligibility.ok) {
    return {
      ok: false,
      reason: eligibility.reason === "too_late" ? "too_late" : "illegal_transition",
    };
  }

  if (!(await activeReservation(ctx, input.auctionId))) {
    return { ok: false, reason: "reservation_required" };
  }

  await db.patch(input.auctionId, { status: "OPEN" });

  await recordAuditEvent(ctx, {
    actorId,
    actorRole,
    action: "auction.opened",
    entityType: "auctions",
    entityId: input.auctionId,
    meta: { code: auction.code },
  });

  return { ok: true, auctionId: input.auctionId, replayed: false };
}

/* ══════════════════════════ CLOSE (OPEN → CLOSED) — finalization seam ══════════════════════════ */

export type CloseFinalizationResult =
  | {
      /** "WINNER" keeps the auction CLOSED with settlement pending (Phase I). */
      result: "WINNER" | "NO_WINNER";
    }
  | {
      /** Phase I frozen extension: determination exceeded the per-tx page
       * budget. The hook persisted/advanced the determination campaign;
       * `closeAuction` must NOT apply the CLOSED patch — the auction stays
       * OPEN (bids refused by time) until the close sweep resumes and the
       * walk concludes. */
      deferred: true;
      reason: "determination_deferred";
    };

/**
 * Phase I composition hook: winner determination + settlement-pending /
 * NO_WINNER release run INSIDE the close transaction. Throwing aborts the
 * whole finalization (zero partial state).
 */
export type CloseFinalization = (
  ctx: { db: unknown },
  input: { auctionId: Id<"auctions">; now: number },
) => Promise<CloseFinalizationResult>;

export type CloseAuctionInput = {
  auctionId: Id<"auctions">;
  /** Server clock (TRD §17) — the authoritative close comparison. */
  now: number;
  /** Phase I composes winner determination here (same transaction). */
  finalize?: CloseFinalization;
};

export type CloseAuctionResult =
  | {
      ok: true;
      auctionId: Id<"auctions">;
      replayed: boolean;
      /** Phase I's determination outcome; null until composed. */
      result: "WINNER" | "NO_WINNER" | null;
    }
  | {
      ok: false;
      reason: "auction_not_found" | "illegal_transition" | "too_early";
    };

/**
 * Close/finalization seam: OPEN → CLOSED at/after the authoritative close
 * time. Time-driven only — an early close refuses (`too_early`); the close
 * time moves only via anti-snipe. Ordering guarantee: finalization (the
 * Phase I hook) runs BEFORE the CLOSED state commits — the status patch,
 * `resultDeterminedAt`, and the determination outcome are one transaction,
 * so CLOSED only ever commits with a determined result (TRD §9 meaning:
 * bidding ended + result determined): WINNER ⇒ settlement pending
 * (inventory stays held); NO_WINNER ⇒ release + refunds + SETTLED. A
 * finalize throw propagates and aborts the transaction — no partial state.
 * Idempotent: re-closing a CLOSED/SETTLED auction replays with zero
 * effect — the sweep cannot double-finalize.
 */
export async function closeAuction(
  ctx: AuctionCtx,
  input: CloseAuctionInput,
): Promise<CloseAuctionResult> {
  const db = ctx.db as LifecycleDb;

  const auction = (await db.get(input.auctionId)) as AuctionRow | null;
  if (auction === null) return { ok: false, reason: "auction_not_found" };
  if (auction.status === "CLOSED" || auction.status === "SETTLED") {
    return { ok: true, auctionId: auction._id, replayed: true, result: null };
  }

  const eligibility = evaluateCloseEligibility({
    status: auction.status,
    closeAt: auction.closeAt,
    now: input.now,
  });
  if (!eligibility.ok) {
    return {
      ok: false,
      reason: eligibility.reason === "too_early" ? "too_early" : "illegal_transition",
    };
  }

  // Verify the OPEN→CLOSED transition is legal for this exact state.
  const transition = requireAuctionTransition(auction.status, "CLOSED");
  if (!transition.ok) return { ok: false, reason: "illegal_transition" };

  // Phase I composition point — the hook runs BEFORE the CLOSED patch (one
  // transaction; commit-order equivalent to the frozen Phase G wording).
  //   Conclusive outcome ⇒ CLOSED + resultDeterminedAt + determination all
  //   commit together (CLOSED commits only with a determined result).
  //   Deferred outcome (frozen Phase I extension: per-tx page budget
  //   exceeded) ⇒ the CLOSED patch is SKIPPED — only the hook's campaign
  //   writes commit; the auction stays OPEN (bids refused by server time)
  //   until the close sweep resumes the walk to a conclusion.
  //   A finalize throw propagates: in Convex any thrown error ABORTS the
  //   transaction, so a failing finalization can never commit anything
  //   (zero partial state).
  let result: "WINNER" | "NO_WINNER" | null = null;
  if (input.finalize !== undefined) {
    const outcome = await input.finalize(ctx, {
      auctionId: input.auctionId,
      now: input.now,
    });
    if ("deferred" in outcome) {
      return { ok: true, auctionId: input.auctionId, replayed: false, result: null };
    }
    result = outcome.result;
  }

  await db.patch(input.auctionId, {
    status: "CLOSED",
    resultDeterminedAt: input.now,
  });

  await recordAuditEvent(ctx, {
    actorId: null,
    actorRole: "system",
    action: "auction.closed",
    entityType: "auctions",
    entityId: input.auctionId,
    meta: { code: auction.code, closeAt: auction.closeAt },
  });

  return { ok: true, auctionId: input.auctionId, replayed: false, result };
}

/* ══════════════════════════ Anti-snipe application (TRD §18) ══════════════════════════ */

export type ApplyAntiSnipeInput = {
  auctionId: Id<"auctions">;
  /** Server clock (TRD §17) — the trigger-window comparison. */
  now: number;
};

export type ApplyAntiSnipeResult =
  | {
      ok: true;
      auctionId: Id<"auctions">;
      /** False when anti-snipe is unset or this instant is outside the window. */
      active: boolean;
      newCloseAt: number | null;
    }
  | {
      ok: false;
      reason:
        | "auction_not_found"
        | "not_open"
        | "antisnipe_exhausted";
    };

/**
 * Apply one anti-snipe extension, atomically and auditably: extend the
 * authoritative closeAt and bump extensionCount in the same transaction,
 * bounded by the configured maximum. Unset configuration ⇒ inactive with
 * zero effect. Phase H composes this inside the bid transaction; nothing
 * calls it yet.
 */
export async function applyAntiSnipeExtension(
  ctx: AuctionCtx,
  input: ApplyAntiSnipeInput,
): Promise<ApplyAntiSnipeResult> {
  const db = ctx.db as LifecycleDb;

  const auction = (await db.get(input.auctionId)) as AuctionRow | null;
  if (auction === null) return { ok: false, reason: "auction_not_found" };
  if (auction.status !== "OPEN") return { ok: false, reason: "not_open" };

  const evaluation = evaluateAntiSnipeExtension({
    now: input.now,
    closeAt: auction.closeAt,
    antiSnipeWindowMs: auction.antiSnipeWindowMs,
    antiSnipeExtendMs: auction.antiSnipeExtendMs,
    antiSnipeMaxExtensions: auction.antiSnipeMaxExtensions,
    extensionCount: auction.extensionCount,
  });
  if (!evaluation.ok) return { ok: false, reason: "antisnipe_exhausted" };
  if (!evaluation.active) {
    return { ok: true, auctionId: input.auctionId, active: false, newCloseAt: null };
  }

  await db.patch(input.auctionId, {
    closeAt: evaluation.newCloseAt,
    extensionCount: auction.extensionCount + 1,
  });

  await recordAuditEvent(ctx, {
    actorId: null,
    actorRole: "system",
    action: "auction.antisnipe_extended",
    entityType: "auctions",
    entityId: input.auctionId,
    meta: {
      code: auction.code,
      extensionNumber: auction.extensionCount + 1,
      newCloseAt: evaluation.newCloseAt,
    },
  });

  return {
    ok: true,
    auctionId: input.auctionId,
    active: true,
    newCloseAt: evaluation.newCloseAt,
  };
}

/* ══════════════════════════ Backstop sweeps (scheduled functions) ══════════════════════════ */

export type SweepOpenResult = {
  opened: number;
  scanned: number;
};

/**
 * Open backstop: SCHEDULED auctions whose configured start time has
 * arrived on the server clock (and whose close time has not passed) are
 * opened through the guarded mutation — the sweep never bypasses guards
 * (TRD §9: scheduled function runs call internal mutations).
 */
export async function sweepOpenScheduled(
  ctx: AuctionCtx,
  input: { now: number },
): Promise<SweepOpenResult> {
  const db = ctx.db as LifecycleDb;
  const scheduled = (await db
    .query("auctions")
    .withIndex("by_status_closeAt", (q) => q.eq("status", "SCHEDULED"))
    .collect()) as AuctionRow[];

  let opened = 0;
  for (const auction of scheduled) {
    const eligible = evaluateSweepOpenEligibility({
      startAt: auction.startAt,
      closeAt: auction.closeAt,
      now: input.now,
    });
    if (!eligible.ok) continue;
    const result = await openAuction(ctx, {
      operatorUserId: null,
      auctionId: auction._id,
      now: input.now,
    });
    if (result.ok && !result.replayed) opened += 1;
  }
  return { opened, scanned: scheduled.length };
}

export type SweepCloseResult = {
  closed: number;
  scanned: number;
};

/**
 * Close backstop seam: OPEN auctions past their authoritative close time
 * go through the guarded close mutation (guards never bypassed).
 * ⚠ Deliberately NOT cron-registered in Phase G — Phase I MUST register
 * this sweep in crons.json together with its finalization hook, so every
 * closed auction commits with a determined result. See the module
 * doc-comment.
 */
export async function sweepCloseExpired(
  ctx: AuctionCtx,
  input: { now: number; finalize?: CloseFinalization },
): Promise<SweepCloseResult> {
  const db = ctx.db as LifecycleDb;
  const openAuctions = (await db
    .query("auctions")
    .withIndex("by_status_closeAt", (q) => q.eq("status", "OPEN"))
    .collect()) as AuctionRow[];

  let closed = 0;
  for (const auction of openAuctions) {
    if (input.now < auction.closeAt) continue;
    const result = await closeAuction(ctx, {
      auctionId: auction._id,
      now: input.now,
      finalize: input.finalize,
    });
    if (result.ok && !result.replayed) closed += 1;
  }
  return { closed, scanned: openAuctions.length };
}
