/**
 * LUBA V1 — presentation helper tests (frozen Phase I plan §13/§15).
 *
 * The expired-open presentation condition is derived LOCALLY from the
 * authoritative public contract fields (status, closeAt) and the client
 * clock — no persisted state, no CLOSING lifecycle state, no business
 * authority on the client. The server bid mutation remains the final
 * authority (too_late at/after closeAt, server time).
 */
import { describe, expect, test } from "bun:test";

import { isBidWindowExpired } from "./presentation";

const CLOSE_AT = 1_700_000_000_000;

describe("isBidWindowExpired (presentation-only, client-derived)", () => {
  test("OPEN + clientNow < closeAt → false (live bidding presentation)", () => {
    expect(
      isBidWindowExpired({ status: "OPEN", closeAt: CLOSE_AT, clientNow: CLOSE_AT - 1 }),
    ).toBe(false);
  });

  test("OPEN + clientNow === closeAt → true (boundary is expired)", () => {
    expect(
      isBidWindowExpired({ status: "OPEN", closeAt: CLOSE_AT, clientNow: CLOSE_AT }),
    ).toBe(true);
  });

  test("OPEN + clientNow > closeAt → true (closing/processing-result presentation)", () => {
    expect(
      isBidWindowExpired({ status: "OPEN", closeAt: CLOSE_AT, clientNow: CLOSE_AT + 1 }),
    ).toBe(true);
  });

  test("CLOSED is never the expired-open condition (authoritative lifecycle state)", () => {
    expect(
      isBidWindowExpired({ status: "CLOSED", closeAt: CLOSE_AT, clientNow: CLOSE_AT + 1_000 }),
    ).toBe(false);
  });

  test("SETTLED is never the expired-open condition", () => {
    expect(
      isBidWindowExpired({ status: "SETTLED", closeAt: CLOSE_AT, clientNow: CLOSE_AT + 1_000 }),
    ).toBe(false);
  });

  test("SCHEDULED and DRAFT are never the expired-open condition", () => {
    expect(
      isBidWindowExpired({ status: "SCHEDULED", closeAt: CLOSE_AT, clientNow: CLOSE_AT + 1_000 }),
    ).toBe(false);
    expect(
      isBidWindowExpired({ status: "DRAFT", closeAt: CLOSE_AT, clientNow: CLOSE_AT + 1_000 }),
    ).toBe(false);
  });
});
