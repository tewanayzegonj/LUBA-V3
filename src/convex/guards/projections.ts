/**
 * LUBA V1 — public/private projection helpers.
 *
 * Backend Schema §18 / TRD §19: raw documents are never returned; prohibited
 * fields are structurally absent, not merely hidden. These helpers make it
 * harder for future queries to accidentally expose wallet data, ledger data,
 * internal user IDs, audit metadata, provider information, private
 * fulfillment information, or blind-bidding internals.
 *
 * Mechanism: `projectPublic` is a WHITELIST picker — a projection can only
 * contain fields explicitly listed. `assertNoProhibitedFields` is the test
 * gate used to prove a built object is clean before returning it.
 *
 * No public product queries are implemented here.
 */

/** Tables whose RAW documents are never returned to any client — owners and
 * operators receive sanitized projections built per surface (§18.2/§18.3). */
export const PRIVATE_TABLES = [
  "ledgerEntries",
  "ledgerPostings",
  "provenanceLots",
  "paymentEvents",
  "paymentConfirmations",
  "idempotencyRecords",
  "auditEvents",
  "abuseCounters",
] as const;

/** Fields that must never appear on ANY client-facing projection (public or
 * private). Context-dependent fields (bid amounts, fees, transactional
 * status, configured bounds/fee) are NOT listed here — they are governed by
 * per-surface whitelists and frozen builders like `projectSettledResult`. */
export const PROHIBITED_PROJECTION_FIELDS = [
  // wallet/ledger internals
  "availableSantim",
  "wallet",
  "ledgerEntryId",
  "provenanceLotIds",
  // idempotency / audit internals
  "idempotencyKey",
  "actorId",
  "actorRole",
  "meta",
  // provider information
  "provider",
  "providerRef",
  // internal user ids — surfaces show display names/codes, never raw ids
  "userId",
  "bidderId",
  "winnerId",
  "recipientId",
  "createdBy",
  "paymentEventId",
  // direct PII (Backend Schema §2/§20: never beyond frozen display needs)
  "phone",
  "phoneVerified",
  "email",
  // private fulfillment information
  "deliveryAddress",
  // blind-bidding internals — must never exist on any client surface.
  // NOTE: refundStatus and rejectionReason are deliberately NOT here —
  // PRD Q22 (FROZEN) exposes the OWNER's own bid refund status post-close,
  // and Backend Schema §9 shows the owner a rejection reason class. Those
  // context-dependent owner-surface fields are governed by per-surface
  // whitelists, never a universal ban (a universal ban would make the
  // frozen Q22 own-bids view structurally impossible).
  "winningBidId",
  // uniqueness/ranking leakage guards (fields that must never be invented)
  "isUnique",
  "uniqueCount",
  "duplicateCount",
  "rank",
  "ranking",
  "lowestUniqueSantim",
  "currentWinnerId",
  "bidDistribution",
] as const;

/** Thrown when a prohibited field is detected in a projection candidate. */
export class ProhibitedFieldError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`prohibited field(s) in projection: ${fields.join(", ")}`);
    this.name = "ProhibitedFieldError";
    this.fields = fields;
  }
}

/** True iff `key` is on the prohibited list. */
export function isProhibitedField(key: string): boolean {
  return (PROHIBITED_PROJECTION_FIELDS as readonly string[]).includes(key);
}

/** True iff `table` is on the private-tables list. */
export function isPrivateTable(table: string): boolean {
  return (PRIVATE_TABLES as readonly string[]).includes(table);
}

/* ── Whitelist picker ──
 * The source object is typed loosely on purpose: future queries build
 * candidates from DB documents; the whitelist is the contract. */

/**
 * Build a public projection by picking ONLY whitelisted fields from a
 * source. Whitelist construction fails loudly (throws) if it names a
 * prohibited field — the developer sees the mistake at the call site, not
 * in production.
 */
export function projectPublic<S extends object>(
  source: S,
  whitelist: readonly (Extract<keyof S, string>)[],
): Record<string, unknown> {
  const offenders = whitelist.filter((field) => isProhibitedField(field));
  if (offenders.length > 0) throw new ProhibitedFieldError(offenders);

  const out: Record<string, unknown> = {};
  for (const field of whitelist) {
    const value = (source as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/* ── Settled-result helpers — the frozen public result projection ──
 * Backend Schema §18.1: exactly WINNER/NO_WINNER, winning amount (when
 * winner), close time, final accepted-bid count, prize info, and the winner
 * display name ONLY when consent + name are both present. */

export type SettledResultProjectionInput = {
  result: "WINNER" | "NO_WINNER";
  winningAmountSantim: number | null | undefined;
  closeTime: number;
  finalAcceptedBidCount: number;
  prizeSummary: { title: string; images?: readonly string[] | null };
  /** Winner display data, when a winner exists and was fetched. */
  winnerDisplayName: string | null | undefined;
  winnerPublicConsent: boolean | null | undefined;
};

export type SettledResultPublic = {
  result: "WINNER" | "NO_WINNER";
  winningAmountSantim: number | undefined;
  closeTime: number;
  finalAcceptedBidCount: number;
  prize: { title: string; image: string | null };
  winnerDisplayName: string | null;
};

/**
 * Build the frozen settled-result projection. The winner display name is
 * included only when `publicWinnerConsent === true` AND the name is
 * non-empty — winning never implies consent.
 */
export function projectSettledResult(
  input: SettledResultProjectionInput,
): SettledResultPublic {
  const isWinner = input.result === "WINNER";
  const consented =
    input.winnerPublicConsent === true &&
    typeof input.winnerDisplayName === "string" &&
    input.winnerDisplayName.length > 0;

  const images = input.prizeSummary.images ?? [];
  const primaryImage = images.length > 0 ? images[0] : null;

  return {
    result: input.result,
    winningAmountSantim: isWinner ? (input.winningAmountSantim ?? undefined) : undefined,
    closeTime: input.closeTime,
    finalAcceptedBidCount: input.finalAcceptedBidCount,
    prize: {
      title: input.prizeSummary.title,
      image: primaryImage,
    },
    winnerDisplayName: isWinner && consented ? input.winnerDisplayName! : null,
  };
}
