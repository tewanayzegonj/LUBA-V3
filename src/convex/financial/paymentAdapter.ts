/**
 * LUBA V1 — provider-neutral payment adapter boundary (Phase E foundation).
 *
 * This file is the CONTRACT FUTURE ADAPTERS MUST IMPLEMENT. It deliberately
 * contains NO provider logic, NO network calls, NO credentials — Chapa and
 * links.et adapters (and their OPEN configuration) arrive in later work.
 *
 * The boundary enforces the FROZEN server-authority rules:
 *  - the SERVER determines user, amount, currency (ETB), reference, and
 *    purpose (`PaymentInitiation` is composed server-side from server truth
 *    and handed to the adapter as data — adapters never originate it)
 *  - providers do NOT control wallet balances — an adapter can return
 *    verified payment facts, never balances, never ledger effects
 *  - adapter responses are UNTRUSTED INPUT: everything a provider returns
 *    is a CLAIM (`AdapterEventClaims`) that must pass
 *    `normalizeProviderEvent` + `evaluateConfirmation` against server truth
 *    before any financial effect (Backend Schema §5.2 FROZEN: verified
 *    confirmation is the ONLY trigger for the deposit journal entry)
 *  - provider-specific parsing/normalization/signature checking stays
 *    INSIDE the adapter (behind `parseWebhookEvent`), so the rest of the
 *    system only ever sees the provider-neutral shapes here
 *
 * Adapter method groups:
 *  - `initiatePayment` — create a hosted session/checkout for a
 *    server-composed intent; returns provider routing data only
 *  - `parseWebhookEvent` — provider-specific parsing → neutral claims;
 *    does NOT verify
 *  - `verifyEvent` — server-to-server verification; `verified: true` ONLY
 *    after direct confirmation with the provider
 *  - `verifyReceipt` — optional (links.et scope OPEN — adapters may not
 *    implement it)
 *
 * OPEN decisions preserved (NOT chosen here): Chapa channels/configuration,
 * links.et scope, provider credentials, webhook authentication mechanism,
 * deposit policy, withdrawal policy. Adapters receive credentials through
 * platform-managed env vars via `ProviderCredentials` — never hardcoded.
 */
import type { Id } from "../_generated/dataModel";

import type {
  ConfirmationSource,
  PaymentProvider,
  PaymentPurpose,
} from "../domain/contracts";

/* ── Server-composed intent (the ONLY way a payment starts) ── */

export type PaymentInitiation = {
  /** Resolved server-side from authenticated session + verified phone. */
  userId: Id<"users">;
  provider: PaymentProvider;
  /** V1: deposit only. */
  purpose: PaymentPurpose;
  /** Server-derived amount (integer ETB santims) — never client/provider-claimed. */
  amountSantim: number;
  /** Frozen currency. */
  currency: "ETB";
  /** Server-derived payment reference (sent TO the provider, echoed back). */
  reference: string;
  /** Server-derived idempotency token binding this logical initiation. */
  idempotencyToken: string;
};

/* ── Provider credentials (platform-managed env vars only) ── */

/**
 * Opaque credential carrier. Values come from platform-managed environment
 * variables read in Convex actions ("use node") — never hardcoded, never
 * logged, never persisted, never audited. The exact keys per provider are
 * OPEN until provider configuration is decided.
 */
export type ProviderCredentials = {
  /** Env-var-sourced values; adapters read them, the core never sees them. */
  readonly values: Readonly<Record<string, string>>;
};

/* ── Initiation result (routing data only — no financial truth) ── */

export type InitiatedPaymentSession = {
  /** Provider-side session/checkout reference (routing data). */
  providerSessionRef: string;
  /**
   * Where to send the user. Hosted flows only — V1 never handles raw card
   * data client-side.
   */
  redirectUrl?: string;
  /**
   * Provider transaction reference the provider assigned at initiation,
   * when one exists. Stored on paymentEvents.providerRef (unique where
   * present). Optional — some providers only assign it on completion.
   */
  providerRef?: string;
};

/* ── Untrusted adapter output (claims — never truth) ── */

/**
 * Adapter-normalized claims extracted from a provider response/webhook.
 * Deliberately provider-neutral: the same shape for Chapa, links.et, any
 * future provider. Raw provider payloads, signatures, and credentials MUST
 * NOT be included — they stay inside the adapter and are never persisted.
 */
export type AdapterEventClaims = {
  providerRef: string;
  amountSantim: number;
  userId: string;
  /** Echo of the server-derived payment reference. */
  reference: string;
  currency: string;
};

/**
 * Result of provider-specific webhook parsing. `null` means the adapter
 * could not recognize the payload shape at all (caller treats it as a
 * rejected/unparseable event — never as a confirmation).
 */
export type ParsedWebhookEvent =
  | { ok: true; claims: AdapterEventClaims }
  | { ok: false; reason: "unparseable" }
  | null;

/**
 * Server-to-server verification result. `verified` is true ONLY after the
 * adapter has directly confirmed the event with the provider (TRD §7 §8).
 * When true, the caller still runs the claims through
 * `evaluateConfirmation` against server truth before any effect.
 */
export type VerificationResult =
  | {
      ok: true;
      verified: boolean;
      /** Filled when verified (normalization may still reject). */
      claims?: AdapterEventClaims;
      /** Which frozen confirmation source this result came from. */
      source: ConfirmationSource;
    }
  | { ok: false; reason: string; source: ConfirmationSource };

/* ── The adapter contract ── */

export interface PaymentProviderAdapter {
  /** Frozen provider vocabulary member this adapter handles. */
  readonly provider: PaymentProvider;

  /**
   * Create a hosted payment session for a SERVER-COMPOSED intent.
   * Implementations must not accept amounts/users/references from the
   * provider or the client — only from `initiation`.
   */
  initiatePayment(
    initiation: PaymentInitiation,
    credentials: ProviderCredentials,
  ): Promise<InitiatedPaymentSession>;

  /**
   * Provider-specific webhook parsing → neutral claims. No verification
   * here; output is untrusted by definition. Implementations must drop
   * signatures/credentials/raw payloads before returning.
   */
  parseWebhookEvent(raw: unknown): ParsedWebhookEvent;

  /**
   * Server-to-server verification. MUST re-check directly with the
   * provider (not trust the webhook body). `verified: true` only on
   * direct provider confirmation.
   */
  verifyEvent(
    claims: AdapterEventClaims,
    credentials: ProviderCredentials,
  ): Promise<VerificationResult>;

  /**
   * Optional receipt-verification support (links.et scope OPEN). Default
   * rejection preserves the OPEN decision — an adapter that implements it
   * overrides this method.
   */
  verifyReceipt?(
    receiptInput: unknown,
    credentials: ProviderCredentials,
  ): Promise<VerificationResult>;
}

/** Type guard: is an object a payment adapter for the frozen vocabulary? */
export function isPaymentProviderAdapter(
  value: unknown,
): value is PaymentProviderAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { initiatePayment?: unknown }).initiatePayment ===
      "function" &&
    typeof (value as { parseWebhookEvent?: unknown }).parseWebhookEvent ===
      "function" &&
    typeof (value as { verifyEvent?: unknown }).verifyEvent === "function"
  );
}

/**
 * Adapter registry (composition root). Future Chapa/links.et adapters
 * register here; business code looks adapters up by the frozen provider
 * vocabulary — never by importing provider code directly.
 */
const adapters = new Map<PaymentProvider, PaymentProviderAdapter>();

export function registerPaymentAdapter(adapter: PaymentProviderAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getPaymentAdapter(
  provider: PaymentProvider,
): PaymentProviderAdapter | undefined {
  return adapters.get(provider);
}
