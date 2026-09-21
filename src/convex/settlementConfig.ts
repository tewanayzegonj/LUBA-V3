/**
 * LUBA V1 — settlement configuration (Phase I, frozen plan §4/§17).
 *
 * OPEN DECISION O1 — settlement deadline duration. This accessor is the
 * ONLY read site for the deadline policy. Production contract (frozen):
 *
 *   getSettlementDeadlineMs(): number | null
 *
 *   - returns the configured settlement deadline duration when configured;
 *   - returns null ONLY when the deadline policy is not configured;
 *   - no default is invented — ever;
 *   - callers branch on null and FAIL CLOSED: WINNER finalization throws
 *     `settlement_deadline_unconfigured`, which aborts the whole close
 *     transaction — no result-less CLOSED auction can commit (frozen plan
 *     §7). Test-only injection must use isolated test configuration; it
 *     must never become a production default.
 *
 * Until the owner freezes O1, this returns null in production. The value
 * below is the single seam a future configuration freeze edits.
 */
export function getSettlementDeadlineMs(): number | null {
  // O1 [OPEN] — unconfigured. No default is invented.
  return null;
}

/* ── [IMPL] campaign budgets — engineering parameters from §16.5 staging
   metrics, never product policy. Nominal values chosen conservatively
   (~250 bids/chunk ≈ 1,600–1,900 writes, ~25% of the 16,000 docs-written
   cap); the §16.5 staging run must confirm ≥2× headroom before production. ── */

/** Refund-campaign chunk size: bids per chunk transaction. [IMPL] */
export const REFUND_CHUNK_SIZE = 250;

/** Determination-walk page budget: entries per finalize/resume transaction. [IMPL] */
export const DETERMINATION_PAGE_BUDGET = 5000;
