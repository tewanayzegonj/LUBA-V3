import { describe, expect, test } from "bun:test";

import {
  canApplyInventoryAction,
  canTransitionAuction,
  canTransitionSettlement,
  isBidStatus,
  isRejectionReason,
  isReservationResolution,
  isReservationStatus,
  LEGAL_AUCTION_TRANSITIONS,
  requireResolutionForInventoryAction,
  requireSettlementConsistency,
  requireAuctionTransition,
  requireVerifiedPhone,
  validateBidStructure,
  validateReservationQuantity,
  validateWalletProjection,
} from "./rules";

describe("auction lifecycle (TRD §9, FROZEN)", () => {
  test("legal forward transitions are allowed", () => {
    expect(canTransitionAuction("DRAFT", "SCHEDULED")).toBe(true);
    expect(canTransitionAuction("SCHEDULED", "OPEN")).toBe(true);
    expect(canTransitionAuction("OPEN", "CLOSED")).toBe(true);
    expect(canTransitionAuction("CLOSED", "SETTLED")).toBe(true);
  });

  test("skipping, reversing, and terminal self-transitions are illegal", () => {
    expect(canTransitionAuction("DRAFT", "OPEN")).toBe(false);
    expect(canTransitionAuction("DRAFT", "CLOSED")).toBe(false);
    expect(canTransitionAuction("SCHEDULED", "CLOSED")).toBe(false);
    expect(canTransitionAuction("OPEN", "SETTLED")).toBe(false);
    expect(canTransitionAuction("CLOSED", "OPEN")).toBe(false);
    expect(canTransitionAuction("SETTLED", "CLOSED")).toBe(false);
    expect(canTransitionAuction("SETTLED", "SETTLED")).toBe(false);
    expect(canTransitionAuction("OPEN", "OPEN")).toBe(false);
  });

  test("strict transition rejects self-transitions explicitly", () => {
    expect(requireAuctionTransition("OPEN", "CLOSED").ok).toBe(true);
    expect(requireAuctionTransition("OPEN", "OPEN").ok).toBe(false);
    expect(requireAuctionTransition("SETTLED", "SETTLED").ok).toBe(false);
  });

  test("no CLOSING state exists anywhere in the machine", () => {
    const statuses = Object.keys(LEGAL_AUCTION_TRANSITIONS);
    expect(statuses).toEqual(["DRAFT", "SCHEDULED", "OPEN", "CLOSED", "SETTLED"]);
  });
});

describe("inventory RESERVE → COMMIT | RELEASE (Backend Schema §7.2)", () => {
  test("reserved admits COMMIT, RELEASE, and CANCEL", () => {
    expect(canApplyInventoryAction("reserved", "COMMIT")).toBe(true);
    expect(canApplyInventoryAction("reserved", "RELEASE")).toBe(true);
    expect(canApplyInventoryAction("reserved", "CANCEL")).toBe(true);
  });

  test("terminal reservation statuses admit nothing", () => {
    expect(canApplyInventoryAction("committed", "COMMIT")).toBe(false);
    expect(canApplyInventoryAction("committed", "RELEASE")).toBe(false);
    expect(canApplyInventoryAction("released", "RELEASE")).toBe(false);
    expect(canApplyInventoryAction("cancelled", "RELEASE")).toBe(false);
    expect(canApplyInventoryAction("cancelled", "CANCEL")).toBe(false);
  });

  test("resolution must match the action", () => {
    expect(requireResolutionForInventoryAction("COMMIT", "settlement").ok).toBe(true);
    expect(requireResolutionForInventoryAction("COMMIT", "void").ok).toBe(false);
    expect(requireResolutionForInventoryAction("RELEASE", "void").ok).toBe(true);
    expect(requireResolutionForInventoryAction("RELEASE", "no_winner").ok).toBe(true);
    expect(requireResolutionForInventoryAction("RELEASE", "settlement").ok).toBe(false);
    expect(requireResolutionForInventoryAction("CANCEL", "cancel_before_open").ok).toBe(true);
    expect(requireResolutionForInventoryAction("CANCEL", "void").ok).toBe(false);
  });
});

describe("settlement state combinations (Backend Schema §11.1)", () => {
  test("pending → paid and pending → voided only", () => {
    expect(canTransitionSettlement("pending", "paid")).toBe(true);
    expect(canTransitionSettlement("pending", "voided")).toBe(true);
    expect(canTransitionSettlement("pending", "pending")).toBe(false);
  });

  test("terminal settlement statuses are frozen", () => {
    expect(canTransitionSettlement("paid", "voided")).toBe(false);
    expect(canTransitionSettlement("voided", "paid")).toBe(false);
    expect(canTransitionSettlement("paid", "pending")).toBe(false);
  });

  test("CLOSED+WINNER requires pending settlement", () => {
    expect(
      requireSettlementConsistency({ auctionStatus: "CLOSED", result: "WINNER", settlementStatus: "pending" }).ok,
    ).toBe(true);
    expect(
      requireSettlementConsistency({ auctionStatus: "CLOSED", result: "WINNER", settlementStatus: "paid" }).ok,
    ).toBe(false);
    expect(
      requireSettlementConsistency({ auctionStatus: "CLOSED", result: "WINNER", settlementStatus: null }).ok,
    ).toBe(false);
  });

  test("CLOSED+NO_WINNER carries no settlement record", () => {
    expect(
      requireSettlementConsistency({ auctionStatus: "CLOSED", result: "NO_WINNER", settlementStatus: null }).ok,
    ).toBe(true);
    expect(
      requireSettlementConsistency({ auctionStatus: "CLOSED", result: "NO_WINNER", settlementStatus: "pending" }).ok,
    ).toBe(false);
  });

  test("SETTLED requires the matching terminal outcome", () => {
    expect(
      requireSettlementConsistency({ auctionStatus: "SETTLED", result: "WINNER", settlementStatus: "paid" }).ok,
    ).toBe(true);
    expect(
      requireSettlementConsistency({ auctionStatus: "SETTLED", result: "WINNER", settlementStatus: "voided" }).ok,
    ).toBe(false);
    expect(
      requireSettlementConsistency({ auctionStatus: "SETTLED", result: "NO_WINNER", settlementStatus: "voided" }).ok,
    ).toBe(true);
    expect(
      requireSettlementConsistency({ auctionStatus: "SETTLED", result: "NO_WINNER", settlementStatus: "paid" }).ok,
    ).toBe(false);
  });
});

describe("bid structural validation (Backend Schema §9)", () => {
  test("positive integer amounts pass without bounds", () => {
    expect(validateBidStructure({ amountSantim: 100, minBidSantim: null, maxBidSantim: null }).ok).toBe(true);
    expect(validateBidStructure({ amountSantim: 1, minBidSantim: undefined, maxBidSantim: undefined }).ok).toBe(true);
  });

  test("negative, zero, fractional, and non-finite amounts fail", () => {
    expect(validateBidStructure({ amountSantim: 0, minBidSantim: null, maxBidSantim: null }).ok).toBe(false);
    expect(validateBidStructure({ amountSantim: -5, minBidSantim: null, maxBidSantim: null }).ok).toBe(false);
    expect(validateBidStructure({ amountSantim: 0.5, minBidSantim: null, maxBidSantim: null }).ok).toBe(false);
    expect(validateBidStructure({ amountSantim: Number.NaN, minBidSantim: null, maxBidSantim: null }).ok).toBe(false);
  });

  test("bounds are enforced only when configured (values OPEN)", () => {
    const belowMin = validateBidStructure({ amountSantim: 50, minBidSantim: 100, maxBidSantim: null });
    expect(belowMin.ok).toBe(false);
    if (!belowMin.ok) expect(belowMin.reason).toBe("out_of_range");
    const aboveMax = validateBidStructure({ amountSantim: 50, minBidSantim: 10, maxBidSantim: 40 });
    expect(aboveMax.ok).toBe(false);
    if (!aboveMax.ok) expect(aboveMax.reason).toBe("out_of_range");
    expect(
      validateBidStructure({ amountSantim: 40, minBidSantim: 10, maxBidSantim: 40 }).ok,
    ).toBe(true);
  });

  test("inverted bounds are invalid regardless of amount", () => {
    const inverted = validateBidStructure({ amountSantim: 20, minBidSantim: 50, maxBidSantim: 10 });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.reason).toBe("invalid_bounds");
  });
});

describe("closed-vocabulary membership", () => {
  test("bid statuses and rejection reasons", () => {
    expect(isBidStatus("ACCEPTED")).toBe(true);
    expect(isBidStatus("PENDING")).toBe(false);
    expect(isRejectionReason("insufficient_funds")).toBe(true);
    expect(isRejectionReason("because")).toBe(false);
  });

  test("reservation statuses and resolutions", () => {
    expect(isReservationStatus("reserved")).toBe(true);
    expect(isReservationStatus("RESERVED")).toBe(false);
    expect(isReservationResolution("no_winner")).toBe(true);
    expect(isReservationResolution("released")).toBe(false);
  });
});

describe("reservation quantity and wallet projection", () => {
  test("quantity must be an integer >= 1", () => {
    expect(validateReservationQuantity(1).ok).toBe(true);
    expect(validateReservationQuantity(0).ok).toBe(false);
    expect(validateReservationQuantity(1.5).ok).toBe(false);
    expect(validateReservationQuantity(-2).ok).toBe(false);
  });

  test("wallet projection must be a non-negative integer santim", () => {
    expect(validateWalletProjection(0).ok).toBe(true);
    expect(validateWalletProjection(12500).ok).toBe(true);
    expect(validateWalletProjection(-1).ok).toBe(false);
    expect(validateWalletProjection(0.5).ok).toBe(false);
  });
});

describe("verified-phone gate (Backend Schema §2, FROZEN)", () => {
  test("verified phone passes", () => {
    expect(requireVerifiedPhone({ phone: "+251911223344", phoneVerified: true }).ok).toBe(true);
  });

  test("fails closed on missing phone or unknown verification flag", () => {
    const missing = requireVerifiedPhone({ phone: null, phoneVerified: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("phone_missing");
    expect(requireVerifiedPhone({ phone: undefined, phoneVerified: true }).ok).toBe(false);
    expect(requireVerifiedPhone({ phone: "", phoneVerified: true }).ok).toBe(false);
    expect(
      requireVerifiedPhone({ phone: "+251911223344", phoneVerified: false }).ok,
    ).toBe(false);
    expect(
      requireVerifiedPhone({ phone: "+251911223344", phoneVerified: null }).ok,
    ).toBe(false);
    expect(
      requireVerifiedPhone({ phone: "+251911223344", phoneVerified: undefined }).ok,
    ).toBe(false);
  });
});
