/**
 * LUBA V1 — atomic inventory reservation primitives (Phase F foundation).
 *
 * The FROZEN inventory model (TRD §12 / Backend Schema §7.2):
 *
 *   RESERVE  — operator-authorized; conditional decrement of the prize's
 *              `availableCount` guarded by `availableCount >= quantity`, the
 *              reservation row, and the audit event, all in ONE transaction.
 *              An auction can never promise inventory it does not hold: a
 *              losing concurrent attempt re-evaluates after its OCC restart
 *              and refuses with `insufficient_inventory`.
 *   COMMIT   — permanently consume a held reservation (status "committed");
 *              only from `reserved`, resolution "settlement". Available
 *              inventory is NOT restored. Wired into the settlement
 *              transaction in Phase I — never invoked before then.
 *   RELEASE  — return a held reservation to available inventory exactly
 *              once; only from `reserved`; resolution void | no_winner |
 *              cancel_before_open (the last maps to status "cancelled").
 *              Wired into void/no_winner/cancellation flows in Phase I.
 *
 * Idempotency model (state guards — the registry key belongs to the
 * wrapping economic mutation in later phases):
 *  - one ACTIVE reservation per auction (`by_auction` lookup guard);
 *    an identical active reservation replays with zero effect, different
 *    parameters conflict, any terminal reservation blocks re-reserving;
 *  - COMMIT/RELEASE of an already-terminal reservation replays (identical
 *    resolution) or refuses (different resolution) — the inventory effect
 *    can occur exactly once because the status transition writes the row
 *    and every competing writer conflicts under Convex OCC;
 *  - every refusal precedes every write; any throw aborts the transaction —
 *    no partial inventory movement, no compensating cleanup writes.
 *
 * Authorization: RESERVE requires an operator-verified actor (verified here
 * AND at the Phase G mutation boundary); RELEASE-family resolution
 * cancel_before_open is operator-attributed, void/no_winner may arrive from
 * the system sweeps. Audit rows use the closed inventory vocabulary.
 *
 * OPEN decisions untouched: multi-auction inventory-line backing, auction
 * lifecycle wiring, settlement wiring, fulfillment specifics.
 */
import type { Id } from "../_generated/dataModel";

import type { ReservationResolution, ReservationStatus } from "../domain/contracts";
import {
  classifyReserveReplay,
  evaluateReleaseDispatch,
  evaluateReserve,
  evaluateInventoryTransition,
  type InventoryRejection,
} from "../domain/inventory";
import { recordAuditEvent } from "../guards/audit";
import { verifyOperatorRow } from "./prizes";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type ReservationRow = {
  _id: Id<"inventoryReservations">;
  prizeId: Id<"prizes">;
  auctionId: Id<"auctions">;
  quantity: number;
  status: ReservationStatus;
  reservedAt: number;
  resolvedAt?: number;
  resolvedBy?: ReservationResolution;
};

type PrizeRow = { _id: Id<"prizes">; availableCount: number };
type UserRow = { _id: Id<"users">; role?: "user" | "operator" };

type ReservationDb = {
  get: (id: Id<"prizes"> | Id<"users"> | Id<"inventoryReservations">) => Promise<
    PrizeRow | UserRow | ReservationRow | null
  >;
  insert: (
    table: "inventoryReservations" | "auditEvents",
    doc: Record<string, unknown>,
  ) => Promise<string>;
  patch: (
    id: Id<"prizes"> | Id<"inventoryReservations">,
    doc: Record<string, unknown>,
  ) => Promise<void>;
  query: (table: "inventoryReservations") => {
    withIndex: (
      name: "by_auction",
      fn: (q: { eq: (field: "auctionId", value: Id<"auctions">) => unknown }) => unknown,
    ) => { collect: () => Promise<ReservationRow[]> };
  };
};

export type ReservationCtx = { db: unknown };

/* ══════════════════════════════ RESERVE ══════════════════════════════ */

export type ReserveInventoryInput = {
  /** Operator actor — verified against the frozen role model. */
  operatorUserId: Id<"users">;
  auctionId: Id<"auctions">;
  prizeId: Id<"prizes">;
  /** Units to hold — integer ≥ 1. */
  quantity: number;
};

export type ReserveInventoryResult =
  | {
      ok: true;
      /** The active reservation backing this auction. */
      reservationId: Id<"inventoryReservations">;
      /** True when an identical active reservation already existed (zero effect). */
      replayed: boolean;
      /** Prize line's availableCount after this call. */
      availableCount: number;
    }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "invalid_quantity"
        | "prize_not_found"
        | "reservation_conflict"
        | "insufficient_inventory"
        | "invalid_inventory_state";
    };

/**
 * RESERVE — atomically hold inventory for an auction. Refusal order:
 * operator verification → quantity structure → prize existence →
 * replay/conflict classification → availability. Every write (line
 * decrement, reservation row, audit) commits together or not at all.
 */
export async function reserveInventory(
  ctx: ReservationCtx,
  input: ReserveInventoryInput,
): Promise<ReserveInventoryResult> {
  const db = ctx.db as ReservationDb;

  const operator = await verifyOperatorRow(ctx, input.operatorUserId);
  if (!operator.ok) return { ok: false, reason: "not_authorized" };

  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return { ok: false, reason: "invalid_quantity" };
  }

  const prize = (await db.get(input.prizeId)) as PrizeRow | null;
  if (prize === null) return { ok: false, reason: "prize_not_found" };

  // One ACTIVE reservation per auction (uniqueness enforced transactionally
  // via lookup-guard; Convex OCC serializes concurrent inserts into the
  // same index range — the losing transaction restarts into this check).
  const existingRows = await db
    .query("inventoryReservations")
    .withIndex("by_auction", (q) => q.eq("auctionId", input.auctionId))
    .collect();
  const active = existingRows.find((row) => row.status === "reserved");
  const anyRow = existingRows[0];
  if (active !== undefined) {
    const classification = classifyReserveReplay(
      { prizeId: active.prizeId, quantity: active.quantity, status: active.status },
      { prizeId: input.prizeId, quantity: input.quantity },
    );
    if (classification.kind === "replay") {
      return {
        ok: true,
        reservationId: active._id,
        replayed: true,
        availableCount: prize.availableCount,
      };
    }
    return { ok: false, reason: "reservation_conflict" };
  }
  if (anyRow !== undefined) {
    // Terminal reservation for this auction — RESERVE is one-shot.
    return { ok: false, reason: "reservation_conflict" };
  }

  // Conditional decrement guard (FROZEN): availableCount >= quantity.
  const evaluation = evaluateReserve({
    availableCount: prize.availableCount,
    quantity: input.quantity,
  });
  if (!evaluation.ok) {
    return {
      ok: false,
      reason: evaluation.reason as "insufficient_inventory" | "invalid_quantity" | "invalid_inventory_state",
    };
  }

  // Apply — one transaction: line decrement + reservation + audit.
  await db.patch(input.prizeId, { availableCount: evaluation.resultingCount });
  const reservationId = (await db.insert("inventoryReservations", {
    prizeId: input.prizeId,
    auctionId: input.auctionId,
    quantity: input.quantity,
    status: "reserved",
    reservedAt: Date.now(),
  })) as Id<"inventoryReservations">;

  await recordAuditEvent(ctx, {
    actorId: operator.operatorUserId,
    actorRole: "operator",
    action: "inventory.reserved",
    entityType: "inventoryReservations",
    entityId: reservationId,
    meta: { quantity: input.quantity, prizeRef: input.prizeId, auctionRef: input.auctionId },
  });

  return {
    ok: true,
    reservationId,
    replayed: false,
    availableCount: evaluation.resultingCount,
  };
}

/* ══════════════════════════════ COMMIT ══════════════════════════════ */

export type CommitReservationInput = {
  reservationId: Id<"inventoryReservations">;
};

export type CommitReservationResult =
  | {
      ok: true;
      reservationId: Id<"inventoryReservations">;
      /** True when the reservation was already committed (zero effect). */
      replayed: boolean;
    }
  | {
      ok: false;
      reason:
        | "reservation_not_found"
        | "terminal_state"
        | "illegal_reservation_status"
        | "illegal_resolution";
    };

/**
 * COMMIT — permanently consume a held reservation (winner's entitlement at
 * settlement, Phase I). Only from `reserved`; `availableCount` is NOT
 * restored. A duplicate COMMIT of an already-committed reservation replays
 * with zero effect; COMMIT against released/cancelled refuses.
 */
export async function commitReservation(
  ctx: ReservationCtx,
  input: CommitReservationInput,
): Promise<CommitReservationResult> {
  const db = ctx.db as ReservationDb;

  const reservation = (await db.get(input.reservationId)) as ReservationRow | null;
  if (reservation === null) return { ok: false, reason: "reservation_not_found" };

  // Already-terminal handling: identical outcome replays; different state
  // (released/cancelled) is illegal — the entitlement can exist only once.
  if (reservation.status === "committed") {
    return { ok: true, reservationId: reservation._id, replayed: true };
  }
  if (reservation.status !== "reserved") {
    return { ok: false, reason: "terminal_state" };
  }

  // FROZEN state machine: COMMIT ⇔ resolution "settlement", from `reserved`.
  const transition = evaluateInventoryTransition(reservation.status, "COMMIT", "settlement");
  if (!transition.ok) return { ok: false, reason: transition.reason };

  await db.patch(input.reservationId, {
    status: "committed",
    resolvedAt: Date.now(),
    resolvedBy: "settlement",
  });

  await recordAuditEvent(ctx, {
    actorId: null,
    actorRole: "system",
    action: "inventory.committed",
    entityType: "inventoryReservations",
    entityId: input.reservationId,
    meta: { quantity: reservation.quantity, prizeRef: reservation.prizeId },
  });

  return { ok: true, reservationId: input.reservationId, replayed: false };
}

/* ══════════════════════════════ RELEASE ══════════════════════════════ */

export type ResolveReservationInput = {
  reservationId: Id<"inventoryReservations">;
  /** void | no_winner → released; cancel_before_open → cancelled. */
  resolution: ReservationResolution;
  /**
   * Operator actor for operator-triggered resolutions (cancel_before_open,
   * manual void). Null for system sweeps (terminal NO_WINNER / deadline
   * void). Non-null actors are verified against the frozen role model.
   */
  operatorUserId: Id<"users"> | null;
};

export type ResolveReservationResult =
  | {
      ok: true;
      reservationId: Id<"inventoryReservations">;
      status: "released" | "cancelled";
      /** True when the reservation was already resolved identically (zero effect). */
      replayed: boolean;
      /** Prize line's availableCount after this call. */
      availableCount: number;
    }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "reservation_not_found"
        | "prize_not_found"
        | "terminal_state"
        | InventoryRejection;
    };

/**
 * RELEASE/CANCEL — return a held reservation to available inventory exactly
 * once, recording the resolution reason. Only from `reserved`; the reserved
 * quantity is restored atomically with the status transition and audit.
 * A duplicate resolution of an identically-resolved reservation replays
 * with zero effect; a conflicting resolution over a terminal state refuses.
 */
export async function resolveReservation(
  ctx: ReservationCtx,
  input: ResolveReservationInput,
): Promise<ResolveReservationResult> {
  const db = ctx.db as ReservationDb;

  // Actor verification (fail closed) when operator-attributed.
  let actorRole: "operator" | "system" = "system";
  let actorId: Id<"users"> | null = null;
  if (input.operatorUserId !== null) {
    const operator = await verifyOperatorRow(ctx, input.operatorUserId);
    if (!operator.ok) return { ok: false, reason: "not_authorized" };
    actorRole = "operator";
    actorId = operator.operatorUserId;
  }

  const reservation = (await db.get(input.reservationId)) as ReservationRow | null;
  if (reservation === null) return { ok: false, reason: "reservation_not_found" };

  // Resolution dispatch over the FROZEN action⇔resolution pairing.
  const dispatch = evaluateReleaseDispatch(input.resolution);
  if (!dispatch.ok) return { ok: false, reason: dispatch.reason };

  // Terminal-state handling: identical resolution replays (zero restore);
  // a conflicting resolution over a terminal state refuses — this is the
  // COMMIT-vs-RELEASE race loser's landing spot after its OCC restart.
  if (reservation.status !== "reserved") {
    const identical =
      reservation.resolvedBy === input.resolution &&
      (reservation.status === "released" || reservation.status === "cancelled");
    if (identical) {
      const prizeForReplay = (await db.get(reservation.prizeId)) as PrizeRow | null;
      if (prizeForReplay === null) return { ok: false, reason: "prize_not_found" };
      return {
        ok: true,
        reservationId: reservation._id,
        status: reservation.status as "released" | "cancelled",
        replayed: true,
        availableCount: prizeForReplay.availableCount,
      };
    }
    return { ok: false, reason: "terminal_state" };
  }

  const transition = evaluateInventoryTransition(
    reservation.status,
    dispatch.action,
    input.resolution,
  );
  if (!transition.ok) return { ok: false, reason: transition.reason };

  // Restore inventory exactly once — the prize line must still exist
  // (checked before any write); the guarded arithmetic cannot overshoot
  // because only THIS reservation's quantity is added back.
  const prize = (await db.get(reservation.prizeId)) as PrizeRow | null;
  if (prize === null) return { ok: false, reason: "prize_not_found" };
  if (!Number.isInteger(prize.availableCount) || prize.availableCount < 0) {
    return { ok: false, reason: "invalid_inventory_state" };
  }
  const restoredCount = prize.availableCount + reservation.quantity;

  await db.patch(reservation.prizeId, { availableCount: restoredCount });
  await db.patch(input.reservationId, {
    status: dispatch.status,
    resolvedAt: Date.now(),
    resolvedBy: input.resolution,
  });

  await recordAuditEvent(ctx, {
    actorId,
    actorRole,
    action: "inventory.released",
    entityType: "inventoryReservations",
    entityId: input.reservationId,
    meta: {
      quantity: reservation.quantity,
      prizeRef: reservation.prizeId,
      resolution: input.resolution,
    },
  });

  return {
    ok: true,
    reservationId: input.reservationId,
    status: dispatch.status as "released" | "cancelled",
    replayed: false,
    availableCount: restoredCount,
  };
}
