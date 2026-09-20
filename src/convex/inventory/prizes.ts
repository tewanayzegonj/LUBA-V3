/**
 * LUBA V1 — server-side prize primitives (Phase F foundation).
 *
 * Operator-side prize lifecycle: creation, permitted-metadata updates, and
 * the public-safe projection. Authorization is ENFORCED here (defense in
 * depth: the Convex mutations in `src/convex/prizes.ts` also run the Phase C
 * `requireOperator` guard — these primitives fail closed on a non-operator
 * actor no matter who calls them).
 *
 * Invariants (Backend Schema §7.1 / TRD §12):
 *  - `availableCount` changes ONLY through RESERVE/RELEASE — prize updates
 *    are structurally unable to touch it (whitelist patch evaluation).
 *  - Every refusal precedes every write; any throw aborts the surrounding
 *    transaction (Convex OCC) — no partial prize state, no compensating writes.
 *  - Every successful create/update writes one sanitized audit row in the
 *    same transaction (closed `operator.action` vocabulary; structured meta).
 *
 * OPEN decisions untouched: deliveryCoverage/pickupLocationRef vocabulary,
 * marketplace listing, auction creation, fulfillment specifics.
 */
import type { Id } from "../_generated/dataModel";

import type { FulfillmentMethod } from "../domain/contracts";
import {
  evaluatePrizeDraft,
  evaluatePrizePatch,
  projectPublicPrize,
  type InventoryRejection,
  type PrizeDraftInput,
  type PublicPrizeProjection,
} from "../domain/inventory";
import { recordAuditEvent } from "../guards/audit";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type PrizeRow = {
  _id: Id<"prizes">;
  title: string;
  description?: string;
  images: string[];
  fulfillmentMethod: FulfillmentMethod;
  deliveryCoverage?: string;
  pickupLocationRef?: string;
  availableCount: number;
  createdAt: number;
};

type UserRow = { _id: Id<"users">; role?: "user" | "operator" };

type PrizeDb = {
  get: (id: Id<"prizes"> | Id<"users">) => Promise<PrizeRow | UserRow | null>;
  insert: (
    table: "prizes" | "auditEvents",
    doc: Record<string, unknown>,
  ) => Promise<string>;
  patch: (id: Id<"prizes">, doc: Record<string, unknown>) => Promise<void>;
};

export type PrizeCtx = { db: unknown };

/* ── Operator verification (shared with inventory/reservations.ts) ── */

export type OperatorVerification =
  | { ok: true; operatorUserId: Id<"users"> }
  | { ok: false; reason: "not_authorized" };

/**
 * Verify the attributed actor holds the frozen `operator` role. Fail-closed:
 * a missing row or any non-operator role refuses. Returns the verified id
 * for audit attribution.
 */
export async function verifyOperatorRow(
  ctx: PrizeCtx,
  operatorUserId: Id<"users">,
): Promise<OperatorVerification> {
  const db = ctx.db as PrizeDb;
  const user = (await db.get(operatorUserId)) as UserRow | null;
  if (user === null || user.role !== "operator") {
    return { ok: false, reason: "not_authorized" };
  }
  return { ok: true, operatorUserId: user._id as Id<"users"> };
}

/* ── Create ── */

export type CreatePrizeInput = {
  operatorUserId: Id<"users">;
  draft: PrizeDraftInput;
};

export type CreatePrizeResult =
  | { ok: true; prizeId: Id<"prizes"> }
  | { ok: false; reason: "not_authorized" | "invalid_prize" };

/**
 * Create an operator-managed prize/inventory line. Operator-verified,
 * domain-evaluated, audited — one transaction, all-or-nothing.
 */
export async function createPrizeRow(
  ctx: PrizeCtx,
  input: CreatePrizeInput,
): Promise<CreatePrizeResult> {
  const db = ctx.db as PrizeDb;

  const operator = await verifyOperatorRow(ctx, input.operatorUserId);
  if (!operator.ok) return { ok: false, reason: "not_authorized" };

  const evaluation = evaluatePrizeDraft(input.draft);
  if (!evaluation.ok) return { ok: false, reason: "invalid_prize" };

  const prizeId = (await db.insert("prizes", {
    ...evaluation.row,
    createdAt: Date.now(),
  })) as Id<"prizes">;

  await recordAuditEvent(ctx, {
    actorId: operator.operatorUserId,
    actorRole: "operator",
    action: "operator.action",
    entityType: "prizes",
    entityId: prizeId,
    meta: { op: "prize.create", fulfillmentMethod: evaluation.row.fulfillmentMethod },
  });

  return { ok: true, prizeId };
}

/* ── Update ── */

export type UpdatePrizeInput = {
  operatorUserId: Id<"users">;
  prizeId: Id<"prizes">;
  /** Whitelist-evaluated patch; `availableCount` is structurally rejected. */
  patch: Record<string, unknown>;
};

export type UpdatePrizeResult =
  | { ok: true; prizeId: Id<"prizes"> }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "prize_not_found"
        | InventoryRejection;
    };

/**
 * Update permitted prize metadata. Inventory (`availableCount`) and the
 * creation timestamp are structurally immutable here — the whitelist
 * evaluator refuses them before any write. Zero-effect refusals: unknown
 * prize, non-operator actor, or any rejected field.
 */
export async function updatePrizeRow(
  ctx: PrizeCtx,
  input: UpdatePrizeInput,
): Promise<UpdatePrizeResult> {
  const db = ctx.db as PrizeDb;

  const operator = await verifyOperatorRow(ctx, input.operatorUserId);
  if (!operator.ok) return { ok: false, reason: "not_authorized" };

  const prize = (await db.get(input.prizeId)) as PrizeRow | null;
  if (prize === null) return { ok: false, reason: "prize_not_found" };

  const evaluation = evaluatePrizePatch(input.patch);
  if (!evaluation.ok) return { ok: false, reason: evaluation.reason };
  if (Object.keys(evaluation.patch).length > 0) {
    await db.patch(input.prizeId, evaluation.patch);
  }

  await recordAuditEvent(ctx, {
    actorId: operator.operatorUserId,
    actorRole: "operator",
    action: "operator.action",
    entityType: "prizes",
    entityId: input.prizeId,
    meta: {
      op: "prize.update",
      fields: Object.keys(evaluation.patch).sort(),
    },
  });

  return { ok: true, prizeId: input.prizeId };
}

/* ── Projections ── */

/**
 * Public-safe prize projection (Backend Schema §18.1): catalog summary and
 * imagery ONLY. Inventory levels and operator configuration never leave the
 * operator boundary.
 */
export function publicPrizeProjection(prize: PrizeRow): PublicPrizeProjection {
  return projectPublicPrize(prize);
}

/**
 * Operator projection (Backend Schema §18.3): the full row is
 * operator-legitimate — prizes carry no user PII and no blind-bidding
 * internals. Never returned to non-privileged callers.
 */
export function operatorPrizeProjection(prize: PrizeRow): PrizeRow {
  return prize;
}
