/**
 * LUBA V1 — server-side auction creation/configuration (Phase G).
 *
 * The operator-only configuration path (TRD §9: "create, configure,
 * publish, open"). Authorization is enforced here AND at the Convex
 * mutation boundary (Phase C `requireOperator`) — defense in depth.
 *
 * Creation composes the Phase F RESERVE primitive in the SAME transaction
 * (TRD §12: "RESERVE at auction creation/configuration"): the auction row
 * and its inventory reservation commit together, so an auction can never
 * exist without holding its inventory. Quantity is 1 — the documented V1
 * dedicated-line default (Backend Schema §7.2); multi-auction line backing
 * remains OPEN.
 *
 * Configuration updates are DRAFT-stage only: after publication the
 * configuration is frozen — the authoritative close time can move ONLY
 * through the deterministic anti-snipe extension (TRD §18).
 *
 * OPEN decisions untouched: fee/bounds values (accepted only as explicit
 * operator config, never defaulted), anti-snipe values (all-or-nothing,
 * unset ⇒ inactive), settlement deadline (NOT configurable here — set at
 * finalization, duration OPEN), inventory-line backing.
 */
import type { Id } from "../_generated/dataModel";

import type { AuctionStatus } from "../domain/contracts";
import {
  evaluateAuctionConfig,
  evaluateAuctionConfigPatch,
  type AuctionConfigInput,
  type AuctionRowDraft,
} from "../domain/auctions";
import { recordAuditEvent } from "../guards/audit";
import { reserveInventory } from "../inventory/reservations";
import { verifyOperatorRow } from "../inventory/prizes";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type AuctionRow = AuctionRowDraft & {
  _id: Id<"auctions">;
  createdBy: Id<"users">;
  status: AuctionStatus;
  /** Runtime; set only when the finalization determines a WINNER. */
  settlementDeadline?: number;
  /** Set at finalization (OPEN→CLOSED). */
  resultDeterminedAt?: number;
  extensionCount: number;
  /** Structural marker of the blind rule — always true in V1. */
  blindMode: boolean;
  createdAt: number;
};

type UserRow = { _id: Id<"users">; role?: "user" | "operator" };

type CreateDb = {
  get: (id: Id<"users"> | Id<"auctions">) => Promise<AuctionRow | UserRow | null>;
  insert: (
    table: "auctions" | "auditEvents",
    doc: Record<string, unknown>,
  ) => Promise<string>;
  patch: (id: Id<"auctions">, doc: Record<string, unknown>) => Promise<void>;
  query: (table: "auctions") => {
    withIndex: (
      name: "by_code",
      fn: (q: { eq: (field: "code", value: string) => unknown }) => unknown,
    ) => { collect: () => Promise<AuctionRow[]> };
  };
};

export type AuctionCtx = { db: unknown };

/* ── Create ── */

export type CreateAuctionInput = {
  operatorUserId: Id<"users">;
  config: AuctionConfigInput;
  /** Server clock (TRD §17) — supplied by the Convex surface, never a client. */
  now: number;
};

export type CreateAuctionResult =
  | {
      ok: true;
      auctionId: Id<"auctions">;
      /** The inventory reservation created with the auction (Phase F). */
      reservationId: Id<"inventoryReservations">;
    }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "code_conflict"
        | "prize_not_found"
        | "insufficient_inventory"
        | "invalid_quantity"
        | "invalid_inventory_state"
        | "invalid_code"
        | "invalid_title"
        | "invalid_description"
        | "invalid_close_time"
        | "invalid_start_time"
        | "invalid_fulfillment_method"
        | "invalid_bounds"
        | "invalid_fee"
        | "invalid_antisnipe_config";
    };

/**
 * Create a DRAFT auction and hold its inventory in ONE transaction:
 * configuration evaluation → code uniqueness (lookup guard; Convex OCC
 * serializes concurrent inserts into the same index range) → auction row →
 * Phase F RESERVE (quantity 1, dedicated-line default) → audit. Any
 * refusal or throw aborts the whole transaction — no auction can exist
 * without its reservation, and no reservation is ever taken for a
 * refused configuration.
 */
export async function createAuctionRow(
  ctx: AuctionCtx,
  input: CreateAuctionInput,
): Promise<CreateAuctionResult> {
  const db = ctx.db as CreateDb;

  const operator = await verifyOperatorRow(ctx, input.operatorUserId);
  if (!operator.ok) return { ok: false, reason: "not_authorized" };

  const evaluation = evaluateAuctionConfig(input.config, input.now);
  if (!evaluation.ok) {
    return { ok: false, reason: evaluation.reason as Exclude<CreateAuctionResult, { ok: true }>["reason"] };
  }

  // Code uniqueness enforced transactionally (lookup guard + Convex OCC).
  const existing = await db
    .query("auctions")
    .withIndex("by_code", (q) => q.eq("code", evaluation.row.code))
    .collect();
  if (existing.length > 0) return { ok: false, reason: "code_conflict" };

  const auctionId = (await db.insert("auctions", {
    ...evaluation.row,
    createdBy: operator.operatorUserId,
    status: "DRAFT",
    extensionCount: 0,
    blindMode: true, // FROZEN structural marker — never operator-configurable
    createdAt: input.now,
  })) as Id<"auctions">;

  // RESERVE at creation (TRD §12) — same transaction, dedicated-line
  // quantity 1 (Backend Schema §7.2 default; multi-line backing OPEN).
  const reservation = await reserveInventory(ctx, {
    operatorUserId: operator.operatorUserId,
    auctionId,
    prizeId: evaluation.row.prizeId,
    quantity: 1,
  });
  if (!reservation.ok) {
    return {
      ok: false,
      reason: reservation.reason as Exclude<CreateAuctionResult, { ok: true }>["reason"],
    };
  }

  await recordAuditEvent(ctx, {
    actorId: operator.operatorUserId,
    actorRole: "operator",
    action: "operator.action",
    entityType: "auctions",
    entityId: auctionId,
    meta: {
      op: "auction.create",
      code: evaluation.row.code,
      closeAt: evaluation.row.closeAt,
    },
  });

  return { ok: true, auctionId, reservationId: reservation.reservationId };
}

/* ── Configure (DRAFT-stage only) ── */

export type UpdateAuctionConfigInput = {
  operatorUserId: Id<"users">;
  auctionId: Id<"auctions">;
  patch: Record<string, unknown>;
  now: number;
};

export type UpdateAuctionConfigResult =
  | { ok: true; auctionId: Id<"auctions"> }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "auction_not_found"
        | "config_frozen"
        | "invalid_schedule"
        | "invalid_code"
        | "invalid_title"
        | "invalid_description"
        | "invalid_close_time"
        | "invalid_start_time"
        | "invalid_fulfillment_method"
        | "invalid_bounds"
        | "invalid_fee"
        | "invalid_antisnipe_config";
    };

/**
 * Re-configure a DRAFT auction. Published auctions refuse (`config_frozen`):
 * after publication the close time is authoritative and moves only through
 * anti-snipe. The merged schedule is re-validated (startAt must remain
 * strictly before closeAt) before any write.
 */
export async function updateAuctionConfigRow(
  ctx: AuctionCtx,
  input: UpdateAuctionConfigInput,
): Promise<UpdateAuctionConfigResult> {
  const db = ctx.db as CreateDb;

  const operator = await verifyOperatorRow(ctx, input.operatorUserId);
  if (!operator.ok) return { ok: false, reason: "not_authorized" };

  const auction = (await db.get(input.auctionId)) as AuctionRow | null;
  if (auction === null) return { ok: false, reason: "auction_not_found" };
  if (auction.status !== "DRAFT") return { ok: false, reason: "config_frozen" };

  const evaluation = evaluateAuctionConfigPatch(input.patch, input.now);
  if (!evaluation.ok) {
    return { ok: false, reason: evaluation.reason as Exclude<UpdateAuctionConfigResult, { ok: true }>["reason"] };
  }

  // Merged-schedule sanity: startAt must remain strictly before closeAt.
  const mergedCloseAt = evaluation.patch.closeAt ?? auction.closeAt;
  const mergedStartAt = evaluation.patch.startAt ?? auction.startAt;
  if (mergedStartAt !== undefined && mergedStartAt >= mergedCloseAt) {
    return { ok: false, reason: "invalid_schedule" };
  }

  if (Object.keys(evaluation.patch).length > 0) {
    await db.patch(input.auctionId, evaluation.patch);
  }

  await recordAuditEvent(ctx, {
    actorId: operator.operatorUserId,
    actorRole: "operator",
    action: "operator.action",
    entityType: "auctions",
    entityId: input.auctionId,
    meta: {
      op: "auction.update",
      fields: Object.keys(evaluation.patch).sort(),
    },
  });

  return { ok: true, auctionId: input.auctionId };
}
