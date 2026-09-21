/**
 * LUBA V1 — winner determination (Phase I, frozen plan §6).
 *
 * FROZEN definition (TRD §10 / PRD): among ACCEPTED bids, the winner is the
 * bid holding the smallest amount that occurs exactly once. No unique amount
 * ⇒ NO_WINNER. No runner-up, no tiebreak, no approximation, no cached
 * counters, no client calculation.
 *
 * Two pure implementations of the same definition:
 *
 *  1. `determineWinner` — the reference: group ascending amount runs, first
 *     singleton wins. Exhaustively tested; the equivalence oracle.
 *
 *  2. The streaming singleton-walk state machine (`initialWalkState` +
 *     `walkStep` + `concludeWalk`) — constant memory, resumable, exercised
 *     over `.paginate()` pages of the `by_auction_status_amount` index
 *     (ACCEPTED-only, amount-ascending). CRITICAL FROZEN SEMANTICS:
 *       - `currentCandidateBidId` belongs ONLY to the current amount run;
 *       - `winnerBidId` is the FIRST confirmed singleton — set when a run
 *         closes with count === 1 and `winnerBidId` is still unset — and is
 *         IMMUTABLE: later confirmed singletons (higher amounts) never
 *         replace it;
 *       - the walk is conclusive ONLY at index exhaustion, because the
 *         authoritative `acceptedCount` completes there; scanning continues
 *         after the winner is identified purely to complete the count;
 *       - every entry increments `acceptedCount`.
 *
 * Determinism: identical input sets ⇒ identical result from any
 * interruption point (property-tested). Rejected bids never reach this
 * module — the index query filters `status === "ACCEPTED"`.
 */
import type { Id } from "../_generated/dataModel";

/* ── Inputs ── */

export type WinnerBidInput = {
  bidId: Id<"bids">;
  amountSantim: number; // integer ETB santims
};

export type WinnerDetermination =
  | {
      result: "WINNER";
      winnerBidId: Id<"bids">;
      /** Winning amount read from the authoritative bid row by the caller. */
      winnerAmountSantim: number;
    }
  | { result: "NO_WINNER" };

/* ── Reference implementation (equivalence oracle) ── */

/**
 * Group-by reference: sort ascending, walk amount runs, first run with
 * count === 1 wins. O(n log n), deterministic (stable on the sorted key —
 * ties on equal amounts are within one run, so ordering among equal amounts
 * never affects the outcome).
 */
export function determineWinner(bids: readonly WinnerBidInput[]): WinnerDetermination {
  const sorted = [...bids].sort((a, b) => a.amountSantim - b.amountSantim);
  let i = 0;
  while (i < sorted.length) {
    const amount = sorted[i].amountSantim;
    let j = i;
    while (j < sorted.length && sorted[j].amountSantim === amount) j += 1;
    const runCount = j - i;
    if (runCount === 1) {
      return {
        result: "WINNER",
        winnerBidId: sorted[i].bidId,
        winnerAmountSantim: sorted[i].amountSantim,
      };
    }
    i = j;
  }
  return { result: "NO_WINNER" };
}

/* ── Streaming walk state machine (resumable; frozen plan §5/§6) ── */

/**
 * Complete persisted walk state. Field names mirror the frozen
 * `settlementCampaigns` columns exactly — the worker maps 1:1, so a resume
 * reconstructs this state without recomputation.
 */
export type WalkState = {
  /** Amount of the run in progress; null on a fresh walk. */
  currentAmount: number | null;
  /** Bids seen so far in the current run (≥ 1 while a run is open). */
  currentRunCount: number;
  /** Candidate of the CURRENT run only (overwritten by every new run). */
  currentCandidateBidId: Id<"bids"> | null;
  /** First confirmed singleton — the winner. IMMUTABLE once set. */
  winnerBidId: Id<"bids"> | null;
  /** Running ACCEPTED total; authoritative at exhaustion. */
  acceptedCount: number;
};

export function initialWalkState(): WalkState {
  return {
    currentAmount: null,
    currentRunCount: 0,
    currentCandidateBidId: null,
    winnerBidId: null,
    acceptedCount: 0,
  };
}

export type WalkEntry = {
  bidId: Id<"bids">;
  amountSantim: number;
};

export type WalkStepResult = {
  state: WalkState;
  /** True on the step where `winnerBidId` transitioned null → set. */
  winnerJustConfirmed: boolean;
};

/**
 * Advance the walk by one index entry (ascending amounts). Pure: returns a
 * NEW state; the caller persists it for resumability.
 */
export function walkStep(prev: WalkState, entry: WalkEntry): WalkStepResult {
  const state: WalkState = {
    currentAmount: prev.currentAmount,
    currentRunCount: prev.currentRunCount,
    currentCandidateBidId: prev.currentCandidateBidId,
    winnerBidId: prev.winnerBidId,
    acceptedCount: prev.acceptedCount + 1, // every entry counts, always
  };

  let winnerJustConfirmed = false;

  if (state.currentAmount === null) {
    // Fresh walk: open the first run.
    state.currentAmount = entry.amountSantim;
    state.currentRunCount = 1;
    state.currentCandidateBidId = entry.bidId;
    return { state, winnerJustConfirmed };
  }

  if (entry.amountSantim === state.currentAmount) {
    // Same run: the candidate can no longer win alone.
    state.currentRunCount += 1;
    return { state, winnerJustConfirmed };
  }

  // New amount ⇒ close the previous run. A run of exactly 1 is a confirmed
  // singleton: the FIRST one becomes the winner and is never replaced
  // (ascending order ⇒ any later singleton has a higher amount).
  if (state.currentRunCount === 1 && state.winnerBidId === null) {
    state.winnerBidId = state.currentCandidateBidId;
    winnerJustConfirmed = true;
  }
  // Open the new run (candidate is replaced; the confirmed winner is not).
  state.currentAmount = entry.amountSantim;
  state.currentRunCount = 1;
  state.currentCandidateBidId = entry.bidId;
  return { state, winnerJustConfirmed };
}

/** Walk a full page of entries through the state machine. */
export function walkPage(prev: WalkState, entries: readonly WalkEntry[]): WalkStepResult {
  let acc: WalkStepResult = { state: prev, winnerJustConfirmed: false };
  for (const entry of entries) {
    const next = walkStep(acc.state, entry);
    // Keep the first confirmation flag of the page; later confirmations are
    // impossible (winnerBidId is immutable), but stay correct regardless.
    acc = { state: next.state, winnerJustConfirmed: acc.winnerJustConfirmed || next.winnerJustConfirmed };
  }
  return acc;
}

export type WalkConclusion =
  | { result: "WINNER"; winnerBidId: Id<"bids"> }
  | { result: "NO_WINNER" };

/**
 * Conclusion — valid ONLY at index exhaustion. Calling this mid-scan would
 * violate the frozen "exhaustion is conclusive" rule; the worker must have
 * observed `isDone` before concluding (the count completes exactly there).
 * The winner AMOUNT is deliberately not produced here: the worker reads it
 * from the authoritative winning bid row (server truth) at commit time.
 */
export function concludeWalk(state: WalkState): WalkConclusion {
  if (state.winnerBidId !== null) {
    return { result: "WINNER", winnerBidId: state.winnerBidId };
  }
  // Exhaustion itself closes the pending final run. A still-open run with a
  // count of exactly 1 is therefore a confirmed singleton — and, no earlier
  // winner having been set, it is the smallest (indeed only) singleton.
  if (
    state.currentAmount !== null &&
    state.currentRunCount === 1 &&
    state.currentCandidateBidId !== null
  ) {
    return { result: "WINNER", winnerBidId: state.currentCandidateBidId };
  }
  return { result: "NO_WINNER" };
}
