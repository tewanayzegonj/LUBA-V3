/**
 * LUBA V1 — pure prize/inventory decision cores (Phase F foundation).
 *
 * Deterministic, side-effect-free evaluation for the operator prize model
 * and the FROZEN inventory model (TRD §12 / Backend Schema §7):
 *
 *   RESERVE  → atomically hold inventory for a specific auction
 *   COMMIT   → permanently consume a held reservation (settlement)
 *   RELEASE  → return a held reservation to available inventory
 *
 * The state machine itself (reserved → committed | released | cancelled,
 * action⇔resolution pairing) is the FROZEN `rules.ts` inventory model —
 * this module composes it; it never redefines it.
 *
 * Server primitives (`inventory/prizes.ts`, `inventory/reservations.ts`)
 * wrap these cores inside transactions with the Phase B/C guards.
 *
 * OPEN decisions untouched: multi-auction inventory-line backing (V1
 * default: dedicated line per auction), fulfillment/delivery specifics,
 * deliveryCoverage/pickupLocationRef vocabulary. No values are defaulted.
 */
import type { Id } from "../_generated/dataModel";

import type {
  FulfillmentMethod,
  ReservationResolution,
  ReservationStatus,
} from "./contracts";
import { FULFILLMENT_METHODS } from "./contracts";
import {
  canApplyInventoryAction,
  requireResolutionForInventoryAction,
  validateReservationQuantity,
  type InventoryAction,
} from "./rules";
import { projectPublic } from "../guards/projections";

/* ── Result convention (same as rules.ts): stable machine reasons ── */

export type InventoryRejection =
  | "invalid_title"
  | "invalid_description"
  | "invalid_images"
  | "invalid_fulfillment_method"
  | "invalid_count"
  | "invalid_field"
  | "immutable_field"
  | "invalid_quantity"
  | "invalid_inventory_state"
  | "insufficient_inventory"
  | "illegal_reservation_status"
  | "illegal_resolution";

function fail<const R extends InventoryRejection>(reason: R): { ok: false; reason: R } {
  return { ok: false, reason };
}

/* ── 1. Prize model ── */

export type PrizeDraftInput = {
  title: string;
  description?: string;
  images: string[];
  fulfillmentMethod: FulfillmentMethod;
  deliveryCoverage?: string;
  pickupLocationRef?: string;
  /** Initial available inventory — integer ≥ 0 (Backend Schema §7.1). */
  initialCount: number;
};

export type PrizeRowDraft = {
  title: string;
  description?: string;
  images: string[];
  fulfillmentMethod: FulfillmentMethod;
  deliveryCoverage?: string;
  pickupLocationRef?: string;
  availableCount: number;
};

/** Structural validation for one operator-supplied prize field value. */
function validatePrizeField(
  field: string,
  value: unknown,
): { ok: true } | { ok: false; reason: InventoryRejection } {
  switch (field) {
    case "title":
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
        return fail("invalid_title");
      }
      return { ok: true };
    case "description":
      if (value !== undefined && (typeof value !== "string" || value.length > 2000)) {
        return fail("invalid_description");
      }
      return { ok: true };
    case "images":
      if (
        !Array.isArray(value) ||
        value.some((img) => typeof img !== "string" || img.length === 0)
      ) {
        return fail("invalid_images");
      }
      return { ok: true };
    case "fulfillmentMethod":
      if (typeof value !== "string" || !(FULFILLMENT_METHODS as readonly string[]).includes(value)) {
        return fail("invalid_fulfillment_method");
      }
      return { ok: true };
    case "deliveryCoverage":
    case "pickupLocationRef":
      if (value !== undefined && typeof value !== "string") {
        return fail("invalid_field");
      }
      return { ok: true };
    default:
      return fail("invalid_field");
  }
}

export type PrizeDraftEvaluation =
  | { ok: true; row: PrizeRowDraft }
  | { ok: false; reason: InventoryRejection };

/**
 * Storage preparation for a `prizes` row: operator-supplied metadata plus
 * the validated initial inventory count. `availableCount` starts at the
 * operator-configured value and changes ONLY through RESERVE/RELEASE —
 * never through prize-metadata updates.
 */
export function evaluatePrizeDraft(input: PrizeDraftInput): PrizeDraftEvaluation {
  for (const [field, value] of Object.entries(input)) {
    if (field === "initialCount") continue;
    const check = validatePrizeField(field, value);
    if (!check.ok) return check;
  }
  if (!Number.isInteger(input.initialCount) || input.initialCount < 0) {
    return fail("invalid_count");
  }
  const row: PrizeRowDraft = {
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    images: [...input.images],
    fulfillmentMethod: input.fulfillmentMethod,
    ...(input.deliveryCoverage !== undefined ? { deliveryCoverage: input.deliveryCoverage } : {}),
    ...(input.pickupLocationRef !== undefined ? { pickupLocationRef: input.pickupLocationRef } : {}),
    availableCount: input.initialCount,
  };
  return { ok: true, row };
}

/** Fields an operator may update after creation (Backend Schema §7.1). */
export const UPDATABLE_PRIZE_FIELDS = [
  "title",
  "description",
  "images",
  "fulfillmentMethod",
  "deliveryCoverage",
  "pickupLocationRef",
] as const;

export type PrizePatchEvaluation =
  | { ok: true; patch: Partial<PrizeRowDraft> }
  | { ok: false; reason: InventoryRejection };

/**
 * Evaluate an operator prize-metadata update. WHITELIST-based: only
 * `UPDATABLE_PRIZE_FIELDS` may appear — `availableCount` and `createdAt`
 * are structurally immutable here (inventory moves only through
 * RESERVE/RELEASE), and any unknown field is refused. Undefined values are
 * dropped (optional fields are not clearable via undefined).
 */
export function evaluatePrizePatch(
  patch: Record<string, unknown>,
): PrizePatchEvaluation {
  const out: Partial<PrizeRowDraft> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!(UPDATABLE_PRIZE_FIELDS as readonly string[]).includes(field)) {
      return fail("immutable_field");
    }
    if (value === undefined) continue;
    const check = validatePrizeField(field, value);
    if (!check.ok) return check;
    (out as Record<string, unknown>)[field] = value;
  }
  return { ok: true, patch: out };
}

/* ── 2. RESERVE legality ── */

export type ReserveEvaluation =
  | { ok: true; resultingCount: number }
  | { ok: false; reason: InventoryRejection };

/**
 * Can `quantity` units be reserved from a line with `availableCount`?
 * The conditional-decrement guard (FROZEN): a reservation is created only
 * when `availableCount >= quantity`; the caller patches the line to
 * `resultingCount` in the SAME transaction. A losing concurrent attempt
 * re-evaluates after its OCC restart and refuses — over-promising is
 * structurally impossible.
 */
export function evaluateReserve(input: {
  availableCount: number;
  quantity: number;
}): ReserveEvaluation {
  const quantity = validateReservationQuantity(input.quantity);
  if (!quantity.ok) return fail("invalid_quantity");
  const { availableCount } = input;
  if (!Number.isInteger(availableCount) || availableCount < 0) {
    return fail("invalid_inventory_state");
  }
  if (availableCount < quantity.value) return fail("insufficient_inventory");
  return { ok: true, resultingCount: availableCount - quantity.value };
}

/* ── 3. Resolution dispatch (RELEASE family) ── */

export type ReleaseFamilyResolution = Extract<
  ReservationResolution,
  "void" | "no_winner" | "cancel_before_open"
>;

export type ReleaseDispatchEvaluation =
  | { ok: true; action: InventoryAction; status: ReservationStatus }
  | { ok: false; reason: InventoryRejection };

/**
 * Map a release-family resolution onto the FROZEN action/status pair:
 * void | no_winner → RELEASE (status "released"); cancel_before_open →
 * CANCEL (status "cancelled"). All three restore the reserved quantity
 * (TRD §12) — only the recorded history differs.
 */
export function evaluateReleaseDispatch(
  resolution: ReservationResolution,
): ReleaseDispatchEvaluation {
  const asRelease = requireResolutionForInventoryAction("RELEASE", resolution);
  if (asRelease.ok) return { ok: true, action: "RELEASE", status: "released" };
  const asCancel = requireResolutionForInventoryAction("CANCEL", resolution);
  if (asCancel.ok) return { ok: true, action: "CANCEL", status: "cancelled" };
  return fail("illegal_resolution");
}

/* ── 4. Transition gate (server primitives compose this) ── */

export type InventoryTransitionEvaluation =
  | { ok: true }
  | { ok: false; reason: "illegal_reservation_status" | "illegal_resolution" };

/**
 * Is applying `action` with `resolution` to a reservation in `status`
 * legal under the FROZEN state machine? COMPOSES rules.ts — COMMIT only
 * from `reserved` with resolution "settlement"; RELEASE only from
 * `reserved` with void|no_winner; CANCEL only from `reserved` with
 * cancel_before_open; terminal states accept nothing.
 */
export function evaluateInventoryTransition(
  status: ReservationStatus,
  action: InventoryAction,
  resolution: ReservationResolution,
): InventoryTransitionEvaluation {
  if (!canApplyInventoryAction(status, action)) {
    return { ok: false, reason: "illegal_reservation_status" };
  }
  const resolutionCheck = requireResolutionForInventoryAction(action, resolution);
  if (!resolutionCheck.ok) return { ok: false, reason: "illegal_resolution" };
  return { ok: true };
}

/* ── 5. Public-safe prize projection (Backend Schema §18.1) ── */

/**
 * The ONLY prize fields a public surface may carry: catalog summary and
 * imagery. Inventory levels, operator configuration (deliveryCoverage /
 * pickupLocationRef), and internal ids are NOT public — they belong to
 * operator projections (§18.3). Built through the Phase B whitelist
 * picker, which fails loudly if a prohibited field is ever added here.
 */
export const PUBLIC_PRIZE_FIELDS = [
  "title",
  "description",
  "images",
  "fulfillmentMethod",
] as const;

export type PublicPrizeProjection = {
  title: string;
  description: string | undefined;
  images: string[];
  fulfillmentMethod: FulfillmentMethod;
};

/** Project a prizes row into the approved public-safe shape. */
export function projectPublicPrize(row: {
  title: string;
  description?: string;
  images: string[];
  fulfillmentMethod: FulfillmentMethod;
}): PublicPrizeProjection {
  const projected = projectPublic(row, PUBLIC_PRIZE_FIELDS);
  return {
    title: projected.title as string,
    description: projected.description as string | undefined,
    images: (projected.images as string[]) ?? [],
    fulfillmentMethod: projected.fulfillmentMethod as FulfillmentMethod,
  };
}

/* ── 6. Replay classification for RESERVE (server primitive composes this) ── */

export type ReserveReplayClassification =
  | { kind: "replay" }
  | { kind: "conflict" }
  | { kind: "blocked" };

/**
 * Classify a RESERVE attempt when the target auction already holds a
 * reservation (one ACTIVE reservation per auction — Backend Schema §7.2):
 *  - active + identical prize & quantity → `replay` (idempotent, zero effect)
 *  - active + different parameters       → `conflict`
 *  - any terminal reservation            → `blocked` (RESERVE is a
 *     creation-time one-shot; a resolved reservation means the auction
 *     lifecycle already advanced past configuration)
 */
export function classifyReserveReplay(
  existing: {
    prizeId: Id<"prizes">;
    quantity: number;
    status: ReservationStatus;
  },
  attempt: { prizeId: Id<"prizes">; quantity: number },
): ReserveReplayClassification {
  if (existing.status === "reserved") {
    const identical =
      existing.prizeId === attempt.prizeId && existing.quantity === attempt.quantity;
    return identical ? { kind: "replay" } : { kind: "conflict" };
  }
  return { kind: "blocked" };
}
