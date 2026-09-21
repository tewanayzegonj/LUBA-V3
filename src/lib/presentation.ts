/**
 * LUBA V1 — presentation helpers (shared/client layer, Phase I frozen plan
 * §13/§15).
 *
 * PURE and PRESENTATION-ONLY. This module lives OUTSIDE `src/convex/**`:
 * React/client code may import it; server/Convex business logic must never
 * depend on client presentation code (one-way boundary — enforced by the
 * Phase I audit scope sweep).
 *
 * The public contract exposes the authoritative `status` and `closeAt`; the
 * client derives the expired-open condition LOCALLY from the client clock:
 *
 *   isBidWindowExpired = (status === "OPEN" && clientNow >= closeAt)
 *
 * When true, presentation must NOT show the auction as LIVE or bid-enabled:
 * no live badge, no bid CTA, no countdown presented as a bid invitation — a
 * closing/processing-result presentation instead (exact copy/visuals belong
 * to the UI/UX Brief).
 *
 * This is a read/presentation condition only: no persisted state, no
 * CLOSING lifecycle state, no server-computed time flag, and NO business
 * authority moves to the client — the server-side bid mutation remains the
 * final authority and rejects bids at/after closeAt using SERVER time
 * (`too_late`), regardless of any client presentation state. Client clock
 * drift affects presentation only.
 */

export type PresentationAuctionStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "OPEN"
  | "CLOSED"
  | "SETTLED";

export function isBidWindowExpired(input: {
  status: PresentationAuctionStatus;
  closeAt: number;
  clientNow: number;
}): boolean {
  return input.status === "OPEN" && input.clientNow >= input.closeAt;
}
