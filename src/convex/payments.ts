/**
 * LUBA V1 — Convex function surface for the payment/deposit flow (Phase E).
 *
 * Deliberately minimal and INTERNAL-ONLY: the deposit flow is driven by
 * verified provider confirmations arriving through future adapter ingress
 * (webhook ingestion / hosted-return verification / receipt verification).
 * There is NO client-callable mutation here — clients cannot confirm
 * payments, choose ledger accounts, or credit arbitrary amounts.
 *
 * This internalMutation is the seam future adapter ingress calls after its
 * server-to-server verification step (Backend Schema §5.2: the verified
 * confirmation is the ONLY trigger for the deposit journal entry). Until
 * that ingress exists, nothing invokes it — by design.
 *
 * OPEN decisions untouched: provider configuration/credentials, webhook
 * authentication, deposit policy, withdrawal policy. No network calls here.
 */
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import type { ConfirmationSource } from "./domain/contracts";
import type { IngestedProviderEvent } from "./domain/payments";
import { confirmAndJournalDeposit } from "./financial/deposit";

/**
 * Internal seam for future adapter ingress: confirm a VERIFIED deposit
 * payment and journal its full economic effect in one transaction.
 *
 * Ingress responsibilities (all OPEN until provider work is approved):
 * adapter server-to-server verification happens BEFORE this call; this
 * function re-performs the exact-match/idempotency/providerRef guards
 * transactionally and journals the effect exactly once. The event argument
 * must already be adapter-verified (`verification: "verified"`) — the
 * confirmation primitive rejects anything else.
 */
export const internalConfirmDeposit = internalMutation({
  args: {
    paymentEventId: v.id("paymentEvents"),
    /** Adapter-normalized, adapter-verified event (verified barrier enforced). */
    event: v.any(),
    /** Frozen confirmation source of this verified attempt. */
    source: v.union(
      v.literal("webhook"),
      v.literal("hosted_return"),
      v.literal("receipt_verification"),
    ),
  },
  handler: async (ctx, args) => {
    const result = await confirmAndJournalDeposit(ctx, {
      paymentEventId: args.paymentEventId,
      event: args.event as IngestedProviderEvent,
      source: args.source as ConfirmationSource,
    });
    // Result is a plain data envelope — safe to return to internal callers.
    return result;
  },
});
