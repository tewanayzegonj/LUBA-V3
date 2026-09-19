/**
 * LUBA V1 — pure provenance-lot rules (Phase D).
 *
 * FROZEN invariant (TRD §6 / Backend Schema §4.4): every refund re-credits
 * the lots that originally funded the refunded amount — provenance is
 * traceable end-to-end and never reclassified. Lot-selection ordering (e.g.
 * FIFO) is IMPL and deliberately NOT chosen here: allocation order is always
 * supplied by the CALLER.
 *
 * Pure module: deterministic, no ctx/db/IO. The server-side primitives in
 * `financial/provenance.ts` apply these decisions atomically.
 *
 * Immutable provenance metadata (§4.4): owner, source reference, original
 * amount, category, creation time. Only `remainingSantim`/`status` move —
 * and only through the controlled consumption/restoration primitives.
 */
import type { Id } from "../_generated/dataModel";

import { isNonNegativeSantim, isPositiveSantim } from "./money";

/* ── Lot shape (as stored / as fetched) ── */

export type ProvenanceLotRow = {
  _id: Id<"provenanceLots">;
  userId: Id<"users">;
  paymentEventId: Id<"paymentEvents">;
  originalSantim: number;
  remainingSantim: number;
  status: "open" | "exhausted";
  /** Funding class carried verbatim — never reclassified (vocabulary OPEN). */
  fundingCategory?: string;
  createdAt: number;
};

/* ── Creation ── */

export type CreateLotInput = {
  userId: Id<"users">;
  /** Source reference of the funds (Backend Schema §4.4: paymentEvent origin). */
  paymentEventId: Id<"paymentEvents">;
  /** > 0 integer santims. */
  originalSantim: number;
  /** Funding class, carried verbatim. Vocabulary OPEN — caller supplies. */
  fundingCategory?: string;
};

export type CreateLotEvaluation =
  | { ok: true }
  | { ok: false; reason: "invalid_amount" | "invalid_user" | "invalid_source" };

/** Structural evaluation of a lot-creation input. Pure. */
export function evaluateLotCreation(input: CreateLotInput): CreateLotEvaluation {
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    return { ok: false, reason: "invalid_user" };
  }
  if (typeof input.paymentEventId !== "string" || input.paymentEventId.length === 0) {
    return { ok: false, reason: "invalid_source" };
  }
  if (!isPositiveSantim(input.originalSantim)) return { ok: false, reason: "invalid_amount" };
  if (input.fundingCategory !== undefined && typeof input.fundingCategory !== "string") {
    return { ok: false, reason: "invalid_source" };
  }
  return { ok: true };
}

/** The immutable initial row content for a new lot. Pure. */
export function initialLotRow(input: CreateLotInput, now: number): ProvenanceLotRow {
  return {
    _id: "" as Id<"provenanceLots">, // assigned by insert; never used pre-insert
    userId: input.userId,
    paymentEventId: input.paymentEventId,
    originalSantim: input.originalSantim,
    remainingSantim: input.originalSantim,
    status: "open",
    fundingCategory: input.fundingCategory,
    createdAt: now,
  };
}

/* ── Consumption (caller-supplied order — no FIFO/LIFO policy here) ── */

export type ConsumeLotInput = {
  lot: ProvenanceLotRow;
  /** Amount to consume from THIS lot, in caller-chosen allocation order. */
  takeSantim: number;
};

export type Allocation = {
  lotId: Id<"provenanceLots">;
  amountSantim: number;
};

export type ConsumptionRejection =
  | "invalid_amount"
  | "lot_not_found"
  | "lot_owner_mismatch"
  | "lot_not_open"
  | "lot_exhausted"
  | "insufficient_provenance";

export type ConsumptionPlan =
  | {
      ok: true;
      /** Exact allocations (lot → amount) in the CALLER's order. */
      allocations: Allocation[];
      /** Total consumed; equals the requested amount. */
      totalSantim: number;
      /** Lot ids fully consumed by this plan (their remaining reaches 0). */
      exhaustedLotIds: Id<"provenanceLots">[];
    }
  | { ok: false; reason: ConsumptionRejection };

/**
 * Allocate a consumption across a CALLER-ORDERED set of lots owned by one
 * user. Deterministic: walks the supplied order, takes as much as each open
 * lot can give, and refuses atomically when total remaining is insufficient.
 * Per-lot `takeSantim` style over-draws are impossible: allocation per lot
 * is capped at the lot's remaining. This function computes the plan only —
 * applying it is the financial layer's atomic job.
 */
export function planLotConsumption(
  ownerUserId: Id<"users">,
  requestedSantim: number,
  lotsInCallerOrder: readonly ProvenanceLotRow[],
): ConsumptionPlan {
  if (!isPositiveSantim(requestedSantim)) return { ok: false, reason: "invalid_amount" };

  const allocations: Allocation[] = [];
  const exhaustedLotIds: Id<"provenanceLots">[] = [];
  let remainingToTake = requestedSantim;

  for (const lot of lotsInCallerOrder) {
    if (remainingToTake === 0) break;
    if (lot.userId !== ownerUserId) return { ok: false, reason: "lot_owner_mismatch" };
    if (lot.status === "exhausted") continue; // skip dead lots; caller's order governs
    if (lot.status !== "open") return { ok: false, reason: "lot_not_open" };
    if (!isNonNegativeSantim(lot.remainingSantim)) return { ok: false, reason: "insufficient_provenance" };
    if (lot.remainingSantim > lot.originalSantim) return { ok: false, reason: "insufficient_provenance" };

    const take = Math.min(lot.remainingSantim, remainingToTake);
    if (take <= 0) continue;
    allocations.push({ lotId: lot._id, amountSantim: take });
    remainingToTake -= take;
    if (take === lot.remainingSantim) exhaustedLotIds.push(lot._id);
  }

  if (remainingToTake > 0) return { ok: false, reason: "insufficient_provenance" };

  return { ok: true, allocations, totalSantim: requestedSantim, exhaustedLotIds };
}

/* ── Restoration (refund re-credit support — not the refund flow) ── */

export type RestoreRecordInput = {
  /** The original allocation being restored (lot → amount, exact). */
  lotId: Id<"provenanceLots">;
  amountSantim: number;
};

export type RestorationRejection =
  | "invalid_amount"
  | "lot_not_found"
  | "lot_owner_mismatch"
  | "lot_unknown_original"
  | "restoration_exceeds_original";

export type RestorationPlan =
  | {
      ok: true;
      /** Exact restorations (lot → amount), validated against each lot's
       * original amount and current remaining. */
      restorations: Allocation[];
      /** Lots that leave `exhausted` and become `open` again. */
      reopenedLotIds: Id<"provenanceLots">[];
      totalSantim: number;
    }
  | { ok: false; reason: RestorationRejection };

/**
 * Validate a restoration of previously consumed provenance. Each lot's
 * AGGREGATE restoration must fit: `remaining + amount <= original` per lot,
 * and every lot must belong to the same owner. Preserves lot
 * identity/category — restoration only moves `remaining`/`status`. Pure;
 * applying it is the financial layer's atomic job.
 */
export function planLotRestoration(
  ownerUserId: Id<"users">,
  restorations: readonly RestoreRecordInput[],
  lotsById: ReadonlyMap<Id<"provenanceLots">, ProvenanceLotRow>,
): RestorationPlan {
  if (!Array.isArray(restorations) || restorations.length === 0) {
    return { ok: false, reason: "invalid_amount" };
  }

  // Aggregate per lot FIRST: multiple records touching one lot must be
  // validated JOINTLY against the snapshot — two individually-valid records
  // could otherwise over-credit the same lot past its immutable original.
  const perLot = new Map<Id<"provenanceLots">, number>();
  for (const record of restorations) {
    if (!isPositiveSantim(record.amountSantim)) return { ok: false, reason: "invalid_amount" };
    perLot.set(record.lotId, (perLot.get(record.lotId) ?? 0) + record.amountSantim);
  }

  const validated: Allocation[] = [];
  const reopenedLotIds: Id<"provenanceLots">[] = [];
  let total = 0;

  for (const [lotId, amountSantim] of perLot) {
    const lot = lotsById.get(lotId);
    if (lot === undefined) return { ok: false, reason: "lot_not_found" };
    if (lot.userId !== ownerUserId) return { ok: false, reason: "lot_owner_mismatch" };
    if (!isNonNegativeSantim(lot.remainingSantim)) return { ok: false, reason: "restoration_exceeds_original" };

    const resulting = lot.remainingSantim + amountSantim;
    if (resulting > lot.originalSantim) {
      // Restoration can never credit a lot beyond what it originally held —
      // checked on the aggregate; also the structural barrier against
      // re-funding arbitrary lots.
      return { ok: false, reason: "restoration_exceeds_original" };
    }
    if (resulting === lot.originalSantim && lot.status === "exhausted") {
      reopenedLotIds.push(lot._id);
    }
    validated.push({ lotId, amountSantim });
    total += amountSantim;
  }

  return { ok: true, restorations: validated, reopenedLotIds, totalSantim: total };
}
