/**
 * LUBA V1 — payment confirmation primitive (server-side, Phase E foundation).
 *
 * The reusable gate on the path: provider verification → confirmation
 * record → (later primitive) ledger/wallet deposit effect. This task stops
 * at the confirmation record — NO wallet credit and NO ledger posting exist
 * here (Backend Schema §5.2's "confirmed event + verified confirmation is
 * the ONLY trigger for the deposit journal entry" is satisfied by later
 * work calling the ledger primitive only after THIS primitive returns ok).
 *
 * Sequence inside the caller's transaction:
 *   1. load the paymentEvent (server truth)
 *   2. idempotency check — replay returns the original outcome with ZERO
 *      effect; conflict refuses (claims changed for the same event)
 *   3. exact-match evaluation via the pure core (adapter must already have
 *      verified the event server-to-server; every server field must match
 *      the corresponding claim exactly)
 *   4. providerRef journal-once guard — no other confirmed event may share
 *      the provider reference (Backend Schema §5.1 FROZEN)
 *   5. insert paymentConfirmations (verified: true) + patch the event to
 *      `confirmed` + idempotency commit + audit row, all in this transaction
 *
 * Every refusal happens BEFORE any write — no partial state can exist.
 * OPEN decisions untouched: provider configuration, credentials, webhook
 * authentication, deposit/withdrawal policy. No network calls here.
 */
import type { Id } from "../_generated/dataModel";

import type {
  ConfirmationSource,
  PaymentProvider,
  PaymentStatus,
} from "../domain/contracts";
import {
  evaluateConfirmation,
  evaluatePaymentTransition,
  paymentEventReference,
  type ConfirmationRejection,
  type IngestedProviderEvent,
} from "../domain/payments";
import { recordAuditEvent } from "../guards/audit";
import {
  checkIdempotencyKey,
  commitIdempotencyKey,
  deriveIdempotencyKey,
  fingerprintRequest,
} from "../guards/idempotency";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

export type PaymentEventRow = {
  _id: Id<"paymentEvents">;
  userId: Id<"users">;
  provider: PaymentProvider;
  providerRef?: string;
  amountSantim: number;
  status: PaymentStatus;
  initiatedAt: number;
  resolvedAt?: number;
};

type PaymentDb = {
  get: (id: Id<"paymentEvents">) => Promise<PaymentEventRow | null>;
  insert: (
    table: "paymentConfirmations" | "idempotencyRecords" | "auditEvents",
    doc: Record<string, unknown>,
  ) => Promise<string>;
  query: (table: "paymentEvents") => {
    withIndex: (
      name: "by_providerRef",
      fn: (q: { eq: (field: "providerRef", value: string) => unknown }) => unknown,
    ) => { collect: () => Promise<PaymentEventRow[]> };
  };
  patch: (
    id: Id<"paymentEvents">,
    doc: { status: PaymentStatus; resolvedAt?: number },
  ) => Promise<void>;
};

export type PaymentConfirmationCtx = { db: unknown };

/* ── Input / output ── */

export type ConfirmPaymentInput = {
  paymentEventId: Id<"paymentEvents">;
  /** Adapter-normalized, adapter-verified provider event (untrusted claims). */
  event: IngestedProviderEvent;
  /** Which frozen confirmation source delivered this verification attempt. */
  source: ConfirmationSource;
  /**
   * OPTIONAL economic effect executed INSIDE the same transaction after
   * every confirmation check passes, BEFORE the confirmation row is
   * written. This is how the deposit flow composes confirmation + lot
   * creation + ledger + wallet under ONE idempotency key: the effect runs
   * exactly once (replays and conflicts never reach it), and its returned
   * id is merged into the stored outcome so a replay returns the original
   * result. Any throw aborts the whole transaction (OCC) — zero effect.
   */
  effect?: ConfirmationEffect;
};

/** Data the effect may rely on (server truth, already validated). */
export type ConfirmationEffectContext = {
  /** Structural db access inside the caller's transaction. */
  db: unknown;
  paymentEventId: Id<"paymentEvents">;
  /** Verified owner of the payment (server truth). */
  userId: Id<"users">;
  /** Server-derived exact amount (integer ETB santims). */
  amountSantim: number;
  /** Frozen provider vocabulary member for this event. */
  provider: PaymentProvider;
  /** The confirmation source of THIS attempt. */
  source: ConfirmationSource;
  /** The idempotency key shared by confirmation and effect. */
  idempotencyKey: string;
};

export type ConfirmationEffect = {
  /** Must return the effect's entity id; stored for replay. */
  perform: (ctx: ConfirmationEffectContext) => Promise<string>;
  /** Entity table of the effect's outcome (for the registry refType). */
  refType: string;
};

export type PaymentConfirmationRejection =
  | "payment_not_found"
  | "idempotency_conflict"
  | "provider_ref_conflict"
  | ConfirmationRejection;

export type ConfirmPaymentResult =
  | {
      ok: true;
      confirmationId: Id<"paymentConfirmations">;
      paymentEventId: Id<"paymentEvents">;
      /** True when this exact confirmation was already processed (zero effect). */
      replayed: boolean;
      /** The composed effect's entity id (present when an effect ran/is stored). */
      effectRefId: string | null;
      effectRefType: string | null;
    }
  | { ok: false; reason: PaymentConfirmationRejection };

/** The stored idempotency outcome for a successful confirmation. */
function confirmationOutcome(
  paymentEventId: Id<"paymentEvents">,
  confirmationId: Id<"paymentConfirmations">,
  effect?: { effectRefType?: string; effectRefId: string },
): string {
  return JSON.stringify({
    status: "confirmed",
    paymentEventId,
    confirmationId,
    ...(effect !== undefined && effect.effectRefType !== undefined
      ? { effectRefType: effect.effectRefType, effectRefId: effect.effectRefId }
      : {}),
  });
}

/**
 * Confirm a payment event: verify-evaluate-record, idempotently, atomically.
 * The caller's transaction must already hold the adapter-verified event.
 */
export async function confirmPaymentEvent(
  ctx: PaymentConfirmationCtx,
  input: ConfirmPaymentInput,
): Promise<ConfirmPaymentResult> {
  const db = ctx.db as PaymentDb;

  /* 1. Server truth. */
  const row = await db.get(input.paymentEventId);
  if (row === null) return { ok: false, reason: "payment_not_found" };

  /* 2. Idempotency identity: one confirmation lifecycle per payment event;
     the fingerprint covers the REQUEST (claims) so a re-delivery with
     identical claims replays while changed claims conflict. Source- and
     delivery-time-independent: webhook and hosted_return confirming the
     same deposit are the same economic event. */
  const key = deriveIdempotencyKey({
    op: "deposit_confirm",
    userId: row.userId,
    clientToken: input.paymentEventId,
  });
  const fingerprint = fingerprintRequest({
    paymentEventId: input.paymentEventId,
    provider: input.event.provider,
    providerRef: input.event.providerRef,
    claimedAmountSantim: input.event.claimedAmountSantim,
    claimedUserId: input.event.claimedUserId,
    claimedReference: input.event.claimedReference,
    claimedCurrency: input.event.claimedCurrency,
  });

  const idem = await checkIdempotencyKey(ctx, { key, fingerprint });
  if (idem.status === "replay") {
    // The stored outcome carries the full original result (confirmation id
    // plus, when composed, the effect entity). Return it verbatim — ZERO
    // economic effect on this path.
    const stored = JSON.parse(idem.outcome) as {
      confirmationId?: string;
      effectRefType?: string;
      effectRefId?: string;
    };
    return {
      ok: true,
      replayed: true,
      paymentEventId: input.paymentEventId,
      confirmationId:
        stored.confirmationId !== undefined
          ? (stored.confirmationId as Id<"paymentConfirmations">)
          : (idem.refId as Id<"paymentConfirmations">),
      effectRefId: stored.effectRefId ?? null,
      effectRefType: stored.effectRefType ?? null,
    };
  }
  if (idem.status === "conflict") {
    return { ok: false, reason: "idempotency_conflict" };
  }

  /* 3. Exact-match evaluation (pure core; includes the verified gate and
     the `pending_confirmation` precondition — refuses before any write). */
  const evaluation = evaluateConfirmation({
    server: {
      userId: row.userId,
      provider: row.provider,
      amountSantim: row.amountSantim,
      reference: paymentEventReference(row),
      providerRef: row.providerRef,
      status: row.status,
    },
    event: input.event,
    source: input.source,
  });
  if (!evaluation.ok) return { ok: false, reason: evaluation.reason };

  /* 4. ProviderRef journal-once guard: a provider reference can journal
     money exactly once — at this layer that means exactly one CONFIRMED
     event may carry it (the later deposit primitive journals confirmed
     events only). */
  const twinRefs = await db
    .query("paymentEvents")
    .withIndex("by_providerRef", (q) =>
      q.eq("providerRef", input.event.providerRef),
    )
    .collect();
  if (
    twinRefs.some(
      (other) =>
        other._id !== input.paymentEventId && other.status === "confirmed",
    )
  ) {
    return { ok: false, reason: "provider_ref_conflict" };
  }

  /* 5. Apply — same transaction, all-or-nothing. */
  const transition = evaluatePaymentTransition(row.status, "confirmed");
  if (!transition.ok) return { ok: false, reason: "payment_not_confirmable" };

  // 5a. The composed economic effect (if any) runs INSIDE this transaction
  // before the confirmation row exists — replay/conflict never reach it.
  let effectRefId: string | null = null;
  if (input.effect !== undefined) {
    effectRefId = await input.effect.perform({
      db: ctx.db,
      paymentEventId: input.paymentEventId,
      userId: row.userId,
      amountSantim: row.amountSantim,
      provider: row.provider,
      source: input.source,
      idempotencyKey: key,
    });
  }

  const now = Date.now();
  const confirmationId = (await db.insert("paymentConfirmations", {
    paymentEventId: input.paymentEventId,
    source: input.source,
    idempotencyKey: key,
    verified: true, // only ever true: the event arrived adapter-verified
    createdAt: now,
  })) as Id<"paymentConfirmations">;

  await db.patch(input.paymentEventId, {
    status: "confirmed",
    resolvedAt: now,
  });

  await commitIdempotencyKey(ctx, {
    key,
    op: "deposit_confirm",
    userId: row.userId,
    fingerprint,
    // With a composed effect, the registry points at the EFFECT's entity
    // (the economically meaningful outcome — e.g. the ledger entry).
    refType: input.effect !== undefined ? input.effect.refType : "paymentConfirmations",
    refId: effectRefId ?? confirmationId,
    outcome: confirmationOutcome(input.paymentEventId, confirmationId,
      input.effect !== undefined && effectRefId !== null
        ? { effectRefType: input.effect.refType, effectRefId }
        : undefined,
    ),
  });

  // Audit evidence: provider/reference/verification data only — no raw
  // payloads, no credentials (meta is sanitized by the audit foundation;
  // the event fingerprint is a content hash, safe by construction).
  await recordAuditEvent(ctx, {
    actorId: null,
    actorRole: "system",
    action: "deposit.confirmed",
    entityType: "paymentEvents",
    entityId: input.paymentEventId,
    idempotencyKey: key,
    amountSantim: row.amountSantim,
    meta: {
      provider: row.provider,
      source: input.source,
      providerRef: input.event.providerRef,
      eventFingerprint: input.event.payloadFingerprint,
    },
  });

  return {
    ok: true,
    replayed: false,
    confirmationId,
    paymentEventId: input.paymentEventId,
    effectRefId,
    effectRefType: input.effect?.refType ?? null,
  };
}
