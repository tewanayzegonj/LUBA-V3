/**
 * LUBA V1 — deposit confirmation → ledger → wallet → provenance flow
 * (server-side, Phase E).
 *
 * The one reusable server-side operation that turns a VERIFIED provider
 * confirmation into the deposit's economic effect (Backend Schema §5.2
 * FROZEN): a confirmed paymentEvent + verified confirmation is the ONLY
 * trigger for the deposit journal entry.
 *
 * Composition — all inside the CALLER's single Convex transaction:
 *   1. wallet projection ensured (1:1, starts at 0)
 *   2. confirmation checks (idempotency, exact matching, verified barrier,
 *      providerRef journal-once) via the finalized confirmation primitive
 *   3. composed effect (runs exactly once, never on replay/conflict):
 *        a. provenance lot created — tied to the originating payment event
 *        b. balanced journal entry posted via postWalletTransaction:
 *             credit wallet:{userId}  +amount   (funds in)
 *             debit  provider:{p}:settlement  +amount   (source of funds)
 *           wallet projection updated in the SAME transaction
 *        c. ledger entry id returned as the confirmation effect outcome
 *   4. confirmation row + shared idempotency record + audit rows commit
 *      together with every economic write above
 *
 * Guarantees:
 *  - exactly one economic effect per confirmed payment (shared idempotency
 *    key across confirmation and effect; cross-source arrival is replay;
 *    changed claims are conflict; duplicate providerRef is rejected)
 *  - every refusal precedes all writes; any throw aborts the transaction
 *    (Convex OCC) — zero partial economic effect, no compensating writes
 *  - ledger is the truth; wallet is a projection; the lot preserves the
 *    funding provenance end-to-end (deposits create lots)
 *
 * OPEN decisions untouched: provider configuration/credentials/webhook
 * authentication, deposit policy (amounts come from server-confirmed
 * events), withdrawal policy, provenance-category vocabulary (no
 * `fundingCategory` is chosen here — the lot's `paymentEventId` already
 * preserves the funding origin). No network calls in this module.
 */
import type { Id } from "../_generated/dataModel";

import type { ConfirmationSource } from "../domain/contracts";
import type { IngestedProviderEvent } from "../domain/payments";
import { createProvenanceLot } from "./provenance";
import {
  confirmPaymentEvent,
  type PaymentConfirmationRejection,
} from "./paymentConfirmation";
import { ensureWallet, postWalletTransaction } from "./wallet";

/* ── Input / output ── */

export type DepositJournalInput = {
  paymentEventId: Id<"paymentEvents">;
  /** Adapter-normalized, adapter-VERIFIED provider event (untrusted claims). */
  event: IngestedProviderEvent;
  /** Which frozen confirmation source delivered this verified attempt. */
  source: ConfirmationSource;
};

export type DepositWalletBalance = {
  userId: Id<"users">;
  availableSantim: number;
};

export type DepositJournalResult =
  | {
      ok: true;
      status: "posted";
      paymentEventId: Id<"paymentEvents">;
      confirmationId: Id<"paymentConfirmations">;
      /** The balanced deposit journal entry (financial truth). */
      ledgerEntryId: Id<"ledgerEntries">;
      /** The funding-provenance lot created by this deposit. */
      provenanceLotId: Id<"provenanceLots">;
      /** Wallet projection balance AFTER the deposit. */
      walletBalances: DepositWalletBalance[];
    }
  | {
      ok: true;
      status: "replay";
      paymentEventId: Id<"paymentEvents">;
      confirmationId: Id<"paymentConfirmations">;
      /** Original outcome entity ids from the stored registry record. */
      ledgerEntryId: Id<"ledgerEntries"> | null;
      provenanceLotId: null;
      /** No projection mutation occurred on replay. */
      walletBalances: null;
    }
  | { ok: false; reason: PaymentConfirmationRejection };

/**
 * Effect failure = invariant violation. Throwing aborts the whole
 * transaction (Convex OCC) so no partial economic state can persist —
 * there is deliberately NO compensating-cleanup path.
 */
function effectInvariantFailure(what: string, detail: unknown): never {
  throw new Error(`deposit effect invariant failure (${what}): ${JSON.stringify(detail)}`);
}

/**
 * Confirm a verified deposit payment AND journal its full economic effect
 * in ONE transaction: provenance lot + balanced ledger entry + wallet
 * projection + confirmation record + idempotency + audit.
 *
 * Replays return the original outcome with ZERO new effect; conflicts and
 * rejections refuse before any write.
 */
export async function confirmAndJournalDeposit(
  ctx: { db: unknown },
  input: DepositJournalInput,
): Promise<DepositJournalResult> {
  // Captured effect results (closure scope — unset on replay, which is
  // exactly why replay reports the STORED outcome instead).
  let lotId: Id<"provenanceLots"> | null = null;
  let balances: DepositWalletBalance[] | null = null;

  const result = await confirmPaymentEvent(ctx, {
    paymentEventId: input.paymentEventId,
    event: input.event,
    source: input.source,
    effect: {
      refType: "ledgerEntries",
      perform: async (effectCtx) => {
        const effectDb = effectCtx.db as Parameters<typeof ensureWallet>[0]["db"];

        // 1. Wallet projection (1:1). Zero-balance provisioning — not an
        // economic effect; commits atomically with everything else.
        const wallet = await ensureWallet({ db: effectDb }, effectCtx.userId);
        if (!wallet.ok) effectInvariantFailure("ensure_wallet", wallet);

        // 2. Provenance lot — the funding origin of these funds. The
        // vocabulary for fundingCategory remains OPEN: deliberately unset,
        // because paymentEventId already preserves the origin verbatim.
        const lot = await createProvenanceLot({ db: effectDb }, {
          userId: effectCtx.userId,
          paymentEventId: effectCtx.paymentEventId,
          originalSantim: effectCtx.amountSantim,
        });
        if (!lot.ok) effectInvariantFailure("create_lot", lot);
        lotId = lot.lotId;

        // 3. Balanced journal entry + projection update in one transaction.
        // Ledger idempotency token is distinct from (but correlated with)
        // the confirmation key: same user binding, separate registry entry.
        const posted = await postWalletTransaction({ db: effectDb }, {
          kind: "deposit",
          refType: "paymentEvent",
          refId: effectCtx.paymentEventId,
          walletLegs: [
            { userId: effectCtx.userId, deltaSantim: effectCtx.amountSantim },
          ],
          counterpartPostings: [
            {
              account: `provider:${effectCtx.provider}:settlement`,
              direction: "debit",
              amountSantim: effectCtx.amountSantim,
            },
          ],
          ownerUserId: effectCtx.userId,
          idempotencyToken: `ledger:deposit:${effectCtx.paymentEventId}`,
          idempotencyOp: "deposit_confirm",
        });

        if (!posted.ok) {
          // Conflict/rejected here is unreachable in this composition (the
          // confirmation gate ran first and holds the shared lock-equivalent)
          // — treat as an invariant failure and abort the transaction.
          effectInvariantFailure("post_wallet_transaction", posted);
        }
        if (posted.status !== "posted") {
          // A ledger-level replay inside a fresh confirmation is an invariant
          // violation (the effect runs exactly once) — abort rather than
          // double-credit or silently continue.
          effectInvariantFailure("ledger_replay_unreachable", posted);
        }

        balances = posted.balances.map((b) => ({
          userId: b.userId as Id<"users">,
          availableSantim: b.availableSantim,
        }));
        return posted.entryId;
      },
    },
  });

  if (!result.ok) return { ok: false, reason: result.reason };
  if (result.replayed) {
    const ledgerEntryId =
      result.effectRefType === "ledgerEntries" && result.effectRefId !== null
        ? (result.effectRefId as Id<"ledgerEntries">)
        : null;
    return {
      ok: true,
      status: "replay",
      paymentEventId: result.paymentEventId,
      confirmationId: result.confirmationId,
      ledgerEntryId,
      provenanceLotId: null,
      walletBalances: null,
    };
  }

  if (lotId === null || balances === null || result.effectRefId === null) {
    effectInvariantFailure("missing_effect_result", { lotId, balances, effectRefId: result.effectRefId });
  }

  return {
    ok: true,
    status: "posted",
    paymentEventId: result.paymentEventId,
    confirmationId: result.confirmationId,
    ledgerEntryId: result.effectRefId as Id<"ledgerEntries">,
    provenanceLotId: lotId,
    walletBalances: balances,
  };
}
