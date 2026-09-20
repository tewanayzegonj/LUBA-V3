/**
 * LUBA V1 — pure provider-neutral payment-domain rules (Phase E foundation).
 *
 * Provider-neutral by construction: nothing here knows any provider's API —
 * only the frozen provider vocabulary (`chapa`, `linkset`), the frozen
 * confirmation sources, and the frozen payment statuses. The adapter
 * boundary (`financial/paymentAdapter.ts`) keeps provider-specific parsing
 * INSIDE future adapters; this module sees only adapter-normalized,
 * provider-neutral data.
 *
 * Server authority (FROZEN):
 *  - user, amount, currency, reference, and purpose are server-derived;
 *    provider payloads are UNTRUSTED input until an adapter reports
 *    `verified: true` after server-to-server verification (TRD §7/§8,
 *    Backend Schema §5.2)
 *  - a provider reference can journal money exactly once (Backend Schema
 *    §5.1 FROZEN) — replayed confirmations credit nothing
 *  - single currency: ETB only (frozen); any other currency claim is
 *    rejected at ingestion AND at confirmation
 *
 * OPEN decisions are NOT touched here: Chapa channels/configuration,
 * links.et scope, provider credentials, webhook authentication details,
 * deposit policy, withdrawal policy. No network calls exist in this module.
 */
import type { Id } from "../_generated/dataModel";

import {
  PAYMENT_PURPOSES,
  type ConfirmationSource,
  type EventVerificationStatus,
  type PaymentProvider,
  type PaymentPurpose,
  type PaymentStatus,
} from "./contracts";
import { isPositiveSantim } from "./money";
import { fingerprintRequest } from "../guards/idempotency";

/* ── 1. Payment status transitions ── */

/**
 * Legal paymentEvent status transitions (Backend Schema §5.1).
 * `initiated`/`pending_confirmation` can advance or fail;
 * `confirmed`/`failed` are terminal — one final status per event.
 */
export const LEGAL_PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  initiated: ["pending_confirmation", "failed"],
  pending_confirmation: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
};

export function isLegalPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return LEGAL_PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export type PaymentTransitionEvaluation =
  | { ok: true }
  | { ok: false; reason: "illegal_payment_transition" };

export function evaluatePaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): PaymentTransitionEvaluation {
  if (!isLegalPaymentTransition(from, to)) {
    return { ok: false, reason: "illegal_payment_transition" };
  }
  return { ok: true };
}

/**
 * Recompute the server-derived reference from a STORED paymentEvent row.
 * The reference is a pure function of the row's own fields, so it needs no
 * dedicated schema field — the server can always recompute it for exact
 * claim matching at confirmation time. V1 purpose is deposit-only.
 */
export function paymentEventReference(row: {
  userId: Id<"users">;
  provider: PaymentProvider;
  amountSantim: number;
  initiatedAt: number;
}): string {
  return derivePaymentReference({
    userId: row.userId,
    provider: row.provider,
    purpose: "deposit",
    amountSantim: row.amountSantim,
    initiatedAt: row.initiatedAt,
  });
}

/* ── 2. Payment purpose ── */

/** V1 purpose set is deposit-only (Backend Schema §5.1). */
export function isKnownPaymentPurpose(purpose: string): boolean {
  return (PAYMENT_PURPOSES as readonly string[]).includes(purpose);
}

/* ── 3. Server-derived payment identity ── */

/**
 * The server derives the payment reference — providers never supply it.
 * Deterministic; carries the purpose and the frozen currency. Sent TO the
 * provider at initiation and matched EXACTLY against the provider's echo at
 * confirmation.
 */
export function derivePaymentReference(input: {
  userId: Id<"users">;
  provider: PaymentProvider;
  purpose: PaymentPurpose;
  amountSantim: number;
  initiatedAt: number;
}): string {
  return `pay:${input.provider}:${input.purpose}:etb:${input.userId}:${input.amountSantim}:${input.initiatedAt}`;
}

export type PaymentEventRowDraft = {
  userId: Id<"users">;
  provider: PaymentProvider;
  providerRef?: string;
  amountSantim: number;
  status: PaymentStatus;
  initiatedAt: number;
};

export type PaymentEventDraftInput = {
  userId: Id<"users">;
  provider: PaymentProvider;
  purpose: PaymentPurpose;
  amountSantim: number;
  /** Provider reference — only when the provider already assigned one. */
  providerRef?: string;
  now: number;
};

export type PaymentEventDraftEvaluation =
  | { ok: true; row: PaymentEventRowDraft; reference: string }
  | {
      ok: false;
      reason: "invalid_amount" | "invalid_user" | "invalid_purpose";
    };

/**
 * Storage preparation for a paymentEvents row: server-derived identity,
 * deposit-only purpose, positive integer santim amount, `initiated` status.
 */
export function paymentEventDraft(
  input: PaymentEventDraftInput,
): PaymentEventDraftEvaluation {
  if (!isPositiveSantim(input.amountSantim)) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    return { ok: false, reason: "invalid_user" };
  }
  if (!isKnownPaymentPurpose(input.purpose)) {
    return { ok: false, reason: "invalid_purpose" };
  }
  const reference = derivePaymentReference({
    userId: input.userId,
    provider: input.provider,
    purpose: input.purpose,
    amountSantim: input.amountSantim,
    initiatedAt: input.now,
  });
  const row: PaymentEventRowDraft = {
    userId: input.userId,
    provider: input.provider,
    ...(input.providerRef !== undefined && input.providerRef.length > 0
      ? { providerRef: input.providerRef }
      : {}),
    amountSantim: input.amountSantim,
    status: "initiated",
    initiatedAt: input.now,
  };
  return { ok: true, row, reference };
}

/* ── 4. Provider-event ingestion (untrusted until verified) ── */

export type IngestedProviderEvent = {
  provider: PaymentProvider;
  /** Provider transaction/reference id (never a credential). */
  providerRef: string;
  /** Adapter-normalized amount CLAIM — untrusted. */
  claimedAmountSantim: number;
  /** Adapter-normalized user/reference CLAIMS — untrusted. */
  claimedUserId: string;
  claimedReference: string;
  /** Adapter-normalized currency CLAIM — only ETB can pass ingestion. */
  claimedCurrency: string;
  /** Stable payload fingerprint for evidence (canonical JSON). */
  payloadFingerprint: string;
  /** Server receive time. */
  receivedAt: number;
  /** Always `unverified` at ingestion — verification is an explicit step. */
  verification: EventVerificationStatus;
};

export type ProviderEventRejection =
  | "missing_provider_ref"
  | "missing_user_claim"
  | "missing_reference_claim"
  | "missing_amount_claim"
  | "invalid_amount_claim"
  | "currency_mismatch";

export type ProviderEventIngestion =
  | { ok: true; event: IngestedProviderEvent }
  | { ok: false; reason: ProviderEventRejection };

/**
 * Normalize adapter-supplied claims into an unverified provider event.
 * Every value is captured as a CLAIM — ingestion can never create
 * financial truth. Unknown/extra claim fields (signatures, payloads,
 * credentials) are deliberately DROPPED here: they are never persisted or
 * audited. The fingerprint includes `receivedAt`, so it is evidence of
 * THIS delivery, not the replay identity (see `confirmationFingerprint`).
 */
export function normalizeProviderEvent(
  provider: PaymentProvider,
  claims: {
    providerRef?: unknown;
    amountSantim?: unknown;
    userId?: unknown;
    reference?: unknown;
    currency?: unknown;
  },
  receivedAt: number,
): ProviderEventIngestion {
  const asString = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const providerRef = asString(claims.providerRef);
  const userId = asString(claims.userId);
  const reference = asString(claims.reference);
  const currency = asString(claims.currency);
  const amount =
    typeof claims.amountSantim === "number" ? claims.amountSantim : undefined;

  if (providerRef === undefined) return { ok: false, reason: "missing_provider_ref" };
  if (userId === undefined) return { ok: false, reason: "missing_user_claim" };
  if (reference === undefined) return { ok: false, reason: "missing_reference_claim" };
  if (amount === undefined) return { ok: false, reason: "missing_amount_claim" };
  if (!Number.isFinite(amount)) return { ok: false, reason: "invalid_amount_claim" };
  if (currency !== "ETB") return { ok: false, reason: "currency_mismatch" };

  return {
    ok: true,
    event: {
      provider,
      providerRef,
      claimedAmountSantim: amount,
      claimedUserId: userId,
      claimedReference: reference,
      claimedCurrency: currency,
      payloadFingerprint: fingerprintRequest({
        provider,
        providerRef,
        amount,
        userId,
        reference,
        currency,
        receivedAt,
      }),
      receivedAt,
      verification: "unverified",
    },
  };
}

/**
 * Storage preparation for an ingested provider event: exactly the fields
 * the schema/audit can legitimately persist (reference, fingerprint,
 * receive time, verification status). Raw provider payloads and any
 * credentials are structurally absent — the schema has no field for them
 * and this record never carries them.
 */
export function providerEventStorageRecord(event: IngestedProviderEvent): {
  providerRef: string;
  payloadFingerprint: string;
  receivedAt: number;
  verification: EventVerificationStatus;
} {
  return {
    providerRef: event.providerRef,
    payloadFingerprint: event.payloadFingerprint,
    receivedAt: event.receivedAt,
    verification: event.verification,
  };
}

/* ── 5. Confirmation evaluation (exact matching against server truth) ── */

export type ConfirmationServerRecord = {
  userId: Id<"users">;
  provider: PaymentProvider;
  amountSantim: number;
  /** Server-derived payment reference (sent to the provider at initiation). */
  reference: string;
  /** Provider reference stored on the event, when already assigned. */
  providerRef?: string;
  status: PaymentStatus;
};

export type ConfirmationInput = {
  server: ConfirmationServerRecord;
  /** The ingested (untrusted) provider event, already normalized. */
  event: IngestedProviderEvent;
  /** Which frozen confirmation source produced this verification attempt. */
  source: ConfirmationSource;
};

export type ConfirmationRejection =
  | "provider_mismatch"
  | "provider_ref_mismatch"
  | "reference_mismatch"
  | "user_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "unverified_event"
  | "already_confirmed"
  | "payment_not_confirmable";

/**
 * Replay identity for a confirmation attempt: derived from SERVER truth
 * only — deliberately excludes the confirmation source AND delivery
 * details (receivedAt). A webhook and a hosted-return confirming the same
 * deposit are the SAME economic event: the second arrival classifies as a
 * replay (zero effect) via the idempotency registry, while ANY claim change
 * (amount, user, reference, provider) yields a different fingerprint and
 * therefore a conflict.
 */
export function confirmationFingerprint(input: {
  provider: PaymentProvider;
  reference: string;
  userId: string;
  amountSantim: number;
}): string {
  return fingerprintRequest({
    provider: input.provider,
    reference: input.reference,
    userId: input.userId,
    amountSantim: input.amountSantim,
    currency: "ETB",
  });
}

export type ConfirmationEvaluation =
  | {
      ok: true;
      /** Canonical fingerprint over the verified decision inputs. */
      fingerprint: string;
      /** The one audit action for a successful confirmation. */
      auditAction: "deposit.confirmed";
    }
  | { ok: false; reason: ConfirmationRejection };

/**
 * Evaluate a verification attempt against server truth. Every server field
 * must match the corresponding claim EXACTLY (integer santim equality — no
 * rounding, no tolerance), and the event must already be adapter-verified
 * (`verification === "verified"`) — unverified claims are structurally
 * barred from a financial decision. The result is a DECISION, not an
 * effect: the caller journals the deposit in its own transaction (later
 * primitive).
 */
export function evaluateConfirmation(
  input: ConfirmationInput,
): ConfirmationEvaluation {
  if (input.event.provider !== input.server.provider) {
    return { ok: false, reason: "provider_mismatch" };
  }
  if (
    input.server.providerRef !== undefined &&
    input.server.providerRef !== null &&
    input.event.providerRef !== input.server.providerRef
  ) {
    return { ok: false, reason: "provider_ref_mismatch" };
  }
  if (input.event.claimedReference !== input.server.reference) {
    return { ok: false, reason: "reference_mismatch" };
  }
  if (input.event.claimedUserId !== input.server.userId) {
    return { ok: false, reason: "user_mismatch" };
  }
  if (input.event.claimedAmountSantim !== input.server.amountSantim) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (input.event.claimedCurrency !== "ETB") {
    return { ok: false, reason: "currency_mismatch" };
  }
  // Structural trust gate: the adapter's server-to-server verification must
  // have flipped the event to `verified` BEFORE evaluation. Unverified
  // events can never reach a financial decision (Backend Schema §5.2).
  if (input.event.verification !== "verified") {
    return { ok: false, reason: "unverified_event" };
  }
  if (input.server.status === "confirmed") {
    return { ok: false, reason: "already_confirmed" };
  }
  if (input.server.status !== "pending_confirmation") {
    return { ok: false, reason: "payment_not_confirmable" };
  }
  return {
    ok: true,
    fingerprint: confirmationFingerprint({
      provider: input.server.provider,
      reference: input.server.reference,
      userId: input.server.userId,
      amountSantim: input.server.amountSantim,
    }),
    auditAction: "deposit.confirmed",
  };
}
