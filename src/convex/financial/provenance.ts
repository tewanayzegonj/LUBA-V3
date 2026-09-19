/**
 * LUBA V1 — provenance-lot primitives (server-side, Phase D).
 *
 * FROZEN model (TRD §6 / Backend Schema §4.4): deposits create lots; debits
 * consume lots; every refund re-credits the lots that originally funded the
 * refunded amount. Lots are the provenance carrier that makes wallet debits
 * and refund credits traceable end-to-end.
 *
 * These primitives are deliberately ORDER-AGNOSTIC: consumption walks a
 * caller-supplied lot order (the FIFO/LIFO question stays OPEN/IMPL — no
 * ordering policy is chosen or defaulted here). All application is
 * all-or-nothing inside the caller's transaction: every patch is computed
 * and validated before the first write; a mid-apply failure propagates and
 * Convex OCC rolls the transaction back — no partial lot mutations.
 *
 * Immutable metadata (owner, source, original amount, category, creation
 * time) is enforced structurally: the only patch shape these primitives
 * can issue is { remainingSantim, status }. There is no update path for
 * provenance metadata anywhere.
 *
 * Scope: infrastructure only — no deposit/bid/refund/settlement flow.
 */
import type { Id } from "../_generated/dataModel";

import {
  evaluateLotCreation,
  initialLotRow,
  planLotConsumption,
  planLotRestoration,
  type Allocation,
  type ConsumptionRejection,
  type CreateLotInput,
  type ProvenanceLotRow,
  type RestorationRejection,
  type RestoreRecordInput,
} from "../domain/provenance";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

type ProvenanceDb = {
  insert: (
    table: "provenanceLots",
    doc: {
      userId: Id<"users">;
      paymentEventId: Id<"paymentEvents">;
      originalSantim: number;
      remainingSantim: number;
      status: "open" | "exhausted";
      fundingCategory?: string;
      createdAt: number;
    },
  ) => Promise<string>;
  get: (id: Id<"provenanceLots">) => Promise<ProvenanceLotRow | null>;
  /** The ONLY mutation shape for lot rows — metadata is untouchable. */
  patch: (
    id: string,
    doc: { remainingSantim: number; status: "open" | "exhausted" },
  ) => Promise<void>;
};

export type ProvenanceCtx = { db: unknown };

/** The stored row content for a new lot (immutable provenance metadata). */
export function lotRowFor(input: CreateLotInput, now: number) {
  const row = initialLotRow(input, now);
  return {
    userId: row.userId,
    paymentEventId: row.paymentEventId,
    originalSantim: row.originalSantim,
    remainingSantim: row.remainingSantim,
    status: row.status,
    fundingCategory: row.fundingCategory,
    createdAt: row.createdAt,
  };
}

/* ── Create a funding lot ── */

export type CreateLotResult =
  | {
      ok: true;
      lotId: Id<"provenanceLots">;
      originalSantim: number;
      remainingSantim: number;
    }
  | {
      ok: false;
      reason: "invalid_amount" | "invalid_user" | "invalid_source";
    };

/**
 * Create one funding lot owned by exactly one user, backed by one source
 * reference, carrying its funding category verbatim (vocabulary OPEN —
 * whatever class the caller passes is stored and never reclassified).
 * Remaining starts equal to original.
 */
export async function createProvenanceLot(
  ctx: ProvenanceCtx,
  input: CreateLotInput,
): Promise<CreateLotResult> {
  const db = ctx.db as ProvenanceDb;
  const evaluated = evaluateLotCreation(input);
  if (!evaluated.ok) return evaluated;

  const now = Date.now();
  const lotId = (await db.insert("provenanceLots", lotRowFor(input, now))) as Id<"provenanceLots">;
  return {
    ok: true,
    lotId,
    originalSantim: input.originalSantim,
    remainingSantim: input.originalSantim,
  };
}

/* ── Consume lots (caller-supplied order — no ordering policy here) ── */

export type ConsumeLotsInput = {
  ownerUserId: Id<"users">;
  /** > 0 integer santims to consume in total. */
  requestedSantim: number;
  /** Lot ids in the CALLER's chosen allocation order (FIFO/LIFO stays OPEN). */
  orderedLotIds: Id<"provenanceLots">[];
};

export type ConsumeLotsResult =
  | {
      ok: true;
      /** Exact provenance used (lot → amount), in caller order. */
      allocations: Allocation[];
      totalSantim: number;
      /** Lots whose remaining reached 0 (now `exhausted`). */
      exhaustedLotIds: Id<"provenanceLots">[];
    }
  | { ok: false; reason: ConsumptionRejection };

/**
 * Atomically consume provenance across a caller-ordered set of lots:
 * verify ownership and availability for EVERY lot, compute every resulting
 * row, and only then apply the patches. Insufficient provenance (total
 * remaining < requested) or any invalid lot refuses the whole operation
 * with zero writes. Returns the exact provenance used — the caller embeds
 * these allocation ids on the corresponding ledger postings.
 */
export async function consumeProvenanceLots(
  ctx: ProvenanceCtx,
  input: ConsumeLotsInput,
): Promise<ConsumeLotsResult> {
  const db = ctx.db as ProvenanceDb;

  const lots: ProvenanceLotRow[] = [];
  for (const lotId of input.orderedLotIds) {
    const lot = await db.get(lotId);
    if (lot === null) return { ok: false, reason: "lot_not_found" };
    lots.push(lot);
  }

  const plan = planLotConsumption(input.ownerUserId, input.requestedSantim, lots);
  if (!plan.ok) return plan;

  // Compute every resulting row BEFORE writing anything (all-or-nothing).
  const resulting = new Map<Id<"provenanceLots">, { remainingSantim: number; status: "open" | "exhausted" }>();
  const byId = new Map(lots.map((lot) => [lot._id, lot]));
  for (const allocation of plan.allocations) {
    const lot = byId.get(allocation.lotId);
    if (lot === undefined) return { ok: false, reason: "lot_not_found" };
    const remaining = lot.remainingSantim - allocation.amountSantim;
    if (remaining < 0) return { ok: false, reason: "insufficient_provenance" };
    resulting.set(lot._id, {
      remainingSantim: remaining,
      status: remaining === 0 ? "exhausted" : lot.status,
    });
  }

  for (const [lotId, patch] of resulting) {
    await db.patch(lotId, patch);
  }

  return {
    ok: true,
    allocations: plan.allocations,
    totalSantim: plan.totalSantim,
    exhaustedLotIds: plan.exhaustedLotIds,
  };
}

/* ── Restore lots (refund re-credit support — not the refund flow) ── */

export type RestoreLotsInput = {
  ownerUserId: Id<"users">;
  /** Previously consumed provenance records (lot → exact amount). */
  records: RestoreRecordInput[];
};

export type RestoreLotsResult =
  | {
      ok: true;
      restorations: Allocation[];
      totalSantim: number;
      /** Lots that returned from `exhausted` to `open`. */
      reopenedLotIds: Id<"provenanceLots">[];
    }
  | { ok: false; reason: RestorationRejection };

/**
 * Atomically restore previously consumed provenance to its ORIGINAL lots:
 * each record must reference an existing lot of the same owner, and
 * `remaining + amount` may never exceed the lot's immutable original
 * amount. Lot identity/category are preserved — only remaining/status
 * move. Invalid or mismatched restorations refuse atomically (zero writes).
 */
export async function restoreProvenanceLots(
  ctx: ProvenanceCtx,
  input: RestoreLotsInput,
): Promise<RestoreLotsResult> {
  const db = ctx.db as ProvenanceDb;

  const lotsById = new Map<Id<"provenanceLots">, ProvenanceLotRow>();
  for (const record of input.records) {
    if (lotsById.has(record.lotId)) continue;
    const lot = await db.get(record.lotId);
    if (lot === null) return { ok: false, reason: "lot_not_found" };
    lotsById.set(record.lotId, lot);
  }

  const plan = planLotRestoration(input.ownerUserId, input.records, lotsById);
  if (!plan.ok) return plan;

  // Compute every resulting row BEFORE writing anything (all-or-nothing).
  const resulting = new Map<Id<"provenanceLots">, { remainingSantim: number; status: "open" | "exhausted" }>();
  for (const restoration of plan.restorations) {
    const lot = lotsById.get(restoration.lotId);
    if (lot === undefined) return { ok: false, reason: "lot_not_found" };
    const remaining = lot.remainingSantim + restoration.amountSantim;
    if (remaining > lot.originalSantim) {
      return { ok: false, reason: "restoration_exceeds_original" };
    }
    resulting.set(lot._id, {
      remainingSantim: remaining,
      status:
        lot.status === "exhausted" && remaining === lot.originalSantim
          ? "open"
          : lot.status,
    });
  }

  for (const [lotId, patch] of resulting) {
    await db.patch(lotId, patch);
  }

  return {
    ok: true,
    restorations: plan.restorations,
    totalSantim: plan.totalSantim,
    reopenedLotIds: plan.reopenedLotIds,
  };
}
