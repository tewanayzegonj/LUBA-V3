/**
 * Phase I — pure winner determination tests (frozen plan §6/§16):
 * reference correctness, streaming/reference equivalence, the decoupled
 * immutable winnerBidId, page-boundary cases, and randomized interruption
 * invariance.
 */
import { describe, expect, test } from "bun:test";

import type { Id } from "../_generated/dataModel";
import {
  concludeWalk,
  determineWinner,
  initialWalkState,
  walkPage,
  walkStep,
  type WalkState,
  type WinnerDetermination,
} from "./winner";

const bid = (n: number, amount: number): { bidId: Id<"bids">; amountSantim: number } => ({
  bidId: `b${n}` as Id<"bids">,
  amountSantim: amount,
});

const W = (id: string, amount: number): WinnerDetermination => ({
  result: "WINNER",
  winnerBidId: id as Id<"bids">,
  winnerAmountSantim: amount,
});
const NO_WINNER: WinnerDetermination = { result: "NO_WINNER" };

describe("reference determineWinner", () => {
  test("single unique smallest wins", () => {
    expect(determineWinner([bid(1, 500), bid(2, 300), bid(3, 700)])).toEqual(W("b2", 300));
  });

  test("multiple unique values — minimum wins", () => {
    expect(determineWinner([bid(1, 800), bid(2, 400), bid(3, 600)])).toEqual(W("b2", 400));
  });

  test("no unique value → NO_WINNER (all duplicated)", () => {
    expect(determineWinner([bid(1, 500), bid(2, 500), bid(3, 300), bid(4, 300)])).toEqual(NO_WINNER);
  });

  test("duplicate amounts across bidders — unique smaller still wins", () => {
    expect(
      determineWinner([bid(1, 100), bid(2, 200), bid(3, 200), bid(4, 300), bid(5, 300)]),
    ).toEqual(W("b1", 100));
  });

  test("single bid wins", () => {
    expect(determineWinner([bid(9, 123)])).toEqual(W("b9", 123));
  });

  test("empty set → NO_WINNER", () => {
    expect(determineWinner([])).toEqual(NO_WINNER);
  });

  test("determinism: same input ⇒ same result", () => {
    const bids = [bid(1, 500), bid(2, 300), bid(3, 300), bid(4, 700)];
    expect(determineWinner(bids)).toEqual(determineWinner([...bids].reverse()));
  });
});

describe("streaming walk vs reference equivalence", () => {
  const runWalk = (entries: Array<{ bidId: Id<"bids">; amountSantim: number }>): WalkState => {
    let state = initialWalkState();
    for (const e of entries) state = walkStep(state, e).state;
    return state;
  };

  test("matches reference across randomized sets", () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 1 + Math.floor(Math.random() * 40);
      const entries = Array.from({ length: n }, (_, i) =>
        bid(i, Math.floor(Math.random() * 6) * 100), // heavy duplicates
      );
      const ref = determineWinner(entries);
      // The walk consumes entries in index order (ascending amountSantim),
      // exactly what `by_auction_status_amount` provides in production.
      const ordered = [...entries].sort((a, b) => a.amountSantim - b.amountSantim);
      const end = runWalk(ordered);
      const streamed = concludeWalk(end);
      // concludeWalk deliberately omits the amount (the worker reads it from
      // the authoritative bid row), so equivalence is on result + identity.
      expect(streamed.result).toBe(ref.result);
      if (ref.result === "WINNER") {
        expect(streamed.result === "WINNER" ? streamed.winnerBidId : null).toBe(ref.winnerBidId);
      }
      expect(end.acceptedCount).toBe(n);
    }
  });
});

describe("walk semantics (frozen state machine)", () => {
  test("every entry increments acceptedCount", () => {
    let s = initialWalkState();
    s = walkStep(s, bid(1, 100)).state;
    s = walkStep(s, bid(2, 100)).state;
    s = walkStep(s, bid(3, 200)).state;
    expect(s.acceptedCount).toBe(3);
  });

  test("winner identified early; scan continues; candidate replaced, winner not", () => {
    // b1 wins at 100; later runs replace currentCandidate but not winner.
    let s = initialWalkState();
    s = walkStep(s, bid(1, 100)).state; // run {100}, candidate b1
    s = walkStep(s, bid(2, 200)).state; // close run {100}: WINNER=b1; open {200}
    expect(s.winnerBidId).toBe("b1" as Id<"bids">);
    expect(s.currentCandidateBidId).toBe("b2" as Id<"bids">);
    s = walkStep(s, bid(3, 200)).state; // duplicate run
    s = walkStep(s, bid(4, 300)).state; // close {200}: singleton? no (count 2) — winner unchanged
    expect(s.winnerBidId).toBe("b1" as Id<"bids">);
    s = walkStep(s, bid(5, 300)).state;
    s = walkStep(s, bid(6, 400)).state; // close {300}: count 2 — winner unchanged
    s = walkStep(s, bid(7, 400)).state;
    const c = concludeWalk(s);
    expect(c).toEqual({ result: "WINNER", winnerBidId: "b1" as Id<"bids"> });
    expect(s.acceptedCount).toBe(7);
  });

  test("later singleton must NOT replace the earlier winner", () => {
    let s = initialWalkState();
    s = walkStep(s, bid(1, 100)).state;
    s = walkStep(s, bid(2, 200)).state; // winner = b1
    s = walkStep(s, bid(3, 300)).state; // close {200} singleton b2 — must NOT replace
    expect(s.winnerBidId).toBe("b1" as Id<"bids">);
    const c = concludeWalk(s);
    expect(c).toEqual({ result: "WINNER", winnerBidId: "b1" as Id<"bids"> });
  });

  test("all duplicates → NO_WINNER at exhaustion", () => {
    let s = initialWalkState();
    s = walkStep(s, bid(1, 100)).state;
    s = walkStep(s, bid(2, 100)).state;
    s = walkStep(s, bid(3, 200)).state;
    s = walkStep(s, bid(4, 200)).state;
    expect(concludeWalk(s)).toEqual(NO_WINNER);
  });

  test("exhaustion with pending run: count 1 ⇒ wins", () => {
    let s = initialWalkState();
    s = walkStep(s, bid(1, 500)).state;
    s = walkStep(s, bid(2, 500)).state;
    s = walkStep(s, bid(3, 700)).state; // still open at exhaustion
    expect(concludeWalk(s)).toEqual({ result: "WINNER", winnerBidId: "b3" as Id<"bids"> });
  });
});

describe("page-boundary / resume invariance (frozen test set)", () => {
  const entriesOf = (n: number) =>
    Array.from({ length: n }, (_, i) => bid(i, (i % 4) * 100));

  const concludeFromState = (s: WalkState) => concludeWalk(s);

  test("singleton split across pages — candidate last of page, decided on next page", () => {
    // Page A ends with the sole {100} bid; page B opens {200}.
    const pageA = [bid(1, 200), bid(2, 200), bid(3, 100)];
    const pageB = [bid(4, 200), bid(5, 200)];
    const sA = walkPage(initialWalkState(), pageA).state;
    expect(sA.winnerBidId).toBeNull(); // decision not yet made
    expect(sA.currentCandidateBidId).toBe("b3" as Id<"bids">);
    const sB = walkPage(sA, pageB).state;
    expect(sB.winnerBidId).toBe("b3" as Id<"bids">); // confirmed across the boundary
  });

  test("duplicate run split across pages — count accumulates", () => {
    const sA = walkPage(initialWalkState(), [bid(1, 100)]).state;
    const sB = walkPage(sA, [bid(2, 100), bid(3, 300)]).state;
    expect(sB.winnerBidId).toBeNull(); // {100} closed with count 2
    expect(concludeFromState(sB)).toEqual({ result: "WINNER", winnerBidId: "b3" as Id<"bids"> });
  });

  test("singleton at end of page then confirmed after resume", () => {
    // Page A ends with {300} open (candidate b3); resume closes it as a singleton.
    const sA = walkPage(initialWalkState(), [bid(1, 100), bid(2, 100), bid(3, 300)]).state;
    expect(sA.winnerBidId).toBeNull();
    expect(sA.currentCandidateBidId).toBe("b3" as Id<"bids">);
    expect(sA.currentRunCount).toBe(1);
    const sB = walkPage(sA, [bid(4, 500)]).state;
    expect(sB.winnerBidId).toBe("b3" as Id<"bids">);
  });

  test("singleton at the beginning of the next page", () => {
    const sA = walkPage(initialWalkState(), [bid(1, 100), bid(2, 100)]).state;
    const sB = walkPage(sA, [bid(3, 200)]).state; // new run opens post-resume
    expect(sB.currentRunCount).toBe(1);
    const sC = walkPage(sB, [bid(4, 300)]).state;
    expect(sC.winnerBidId).toBe("b3" as Id<"bids">);
  });

  test("interruption/resume midway through a duplicate run — candidate discarded", () => {
    const sA = walkPage(initialWalkState(), [bid(1, 50), bid(2, 100)]).state;
    const sB = walkPage(sA, [bid(3, 100), bid(4, 200)]).state; // {100} closes count 2
    expect(sB.winnerBidId).toBe("b1" as Id<"bids">); // the 50 singleton was first
    expect(concludeFromState(sB)).toEqual({ result: "WINNER", winnerBidId: "b1" as Id<"bids"> });
  });

  test("early winner survives resume through later duplicate runs", () => {
    const sA = walkPage(initialWalkState(), [bid(1, 100), bid(2, 200)]).state; // winner b1
    const sB = walkPage(sA, [bid(3, 200), bid(4, 300), bid(5, 300), bid(6, 400)]).state;
    expect(sB.winnerBidId).toBe("b1" as Id<"bids">);
    expect(sB.acceptedCount).toBe(6);
  });

  test("resume-point invariance: every interruption point yields identical result+count", () => {
    const entries = entriesOf(37);
    const ref = determineWinner(entries);
    // Walk the full sequence once, snapshotting state at every prefix.
    let s = initialWalkState();
    const snapshots: WalkState[] = [s];
    for (const e of entries) {
      s = walkStep(s, e).state;
      snapshots.push(s);
    }
    const full = concludeWalk(s);
    for (let cut = 0; cut <= entries.length; cut += 1) {
      // Resume from the prefix state with the remaining entries.
      const resumed = walkPage(snapshots[cut], entries.slice(cut)).state;
      const c = concludeWalk(resumed);
      expect(c).toEqual(full);
      expect(resumed.acceptedCount).toBe(entries.length);
    }
  });
});
