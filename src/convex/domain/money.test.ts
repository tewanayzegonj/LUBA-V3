import { describe, expect, test } from "bun:test";

import {
  addSantim,
  compareSantim,
  equalsSantim,
  formatSantimAsBirr,
  hasAvailableSantim,
  isNonNegativeSantim,
  isPositiveSantim,
  parseSantim,
  subtractSantim,
  sumSantim,
  validateSantim,
} from "./money";

describe("validateSantim", () => {
  test("accepts positive integers", () => {
    expect(validateSantim(1).ok).toBe(true);
    expect(validateSantim(12500).ok).toBe(true);
  });

  test("allowZero admits 0 and rejects it otherwise", () => {
    expect(validateSantim(0, { allowZero: true }).ok).toBe(true);
    expect(validateSantim(0).ok).toBe(false);
  });

  test("rejects negatives, non-integers, and non-finite values", () => {
    expect(validateSantim(-1).ok).toBe(false);
    expect(validateSantim(0.5).ok).toBe(false);
    expect(validateSantim(Number.NaN).ok).toBe(false);
  });

  test("rejects values beyond the safe-integer range", () => {
    expect(validateSantim(Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
  });
});

describe("parseSantim", () => {
  test("parses integer strings and numbers exactly", () => {
    expect(parseSantim("125")).toEqual({ ok: true, value: 125 });
    expect(parseSantim(125)).toEqual({ ok: true, value: 125 });
    expect(parseSantim("0", { allowZero: true }).ok).toBe(true);
  });

  test("refuses decimals, exponents, and junk", () => {
    expect(parseSantim("12.50").ok).toBe(false);
    expect(parseSantim("1e3").ok).toBe(false);
    expect(parseSantim("").ok).toBe(false);
    expect(parseSantim("  ")).toEqual({ ok: false, reason: "empty" });
    expect(parseSantim("12a")).toEqual({ ok: false, reason: "bad_format" });
    expect(parseSantim("+12").ok).toBe(false);
    expect(parseSantim("-5").ok).toBe(false);
  });
});

describe("addSantim / subtractSantim / sumSantim", () => {
  test("adds exactly", () => {
    expect(addSantim(100, 250)).toEqual({ ok: true, value: 350 });
    expect(addSantim(0, 0)).toEqual({ ok: true, value: 0 });
  });

  test("subtracts exactly and never goes negative", () => {
    expect(subtractSantim(500, 200)).toEqual({ ok: true, value: 300 });
    expect(subtractSantim(500, 500)).toEqual({ ok: true, value: 0 });
    expect(subtractSantim(100, 101)).toEqual({ ok: false, reason: "negative" });
    expect(subtractSantim(0, 1)).toEqual({ ok: false, reason: "negative" });
  });

  test("sums exactly and validates every element", () => {
    expect(sumSantim([100, 200, 300])).toEqual({ ok: true, value: 600 });
    expect(sumSantim([])).toEqual({ ok: true, value: 0 });
    expect(sumSantim([100, -1])).toEqual({ ok: false, reason: "negative" });
  });
});

describe("comparison and equality", () => {
  test("compares exactly", () => {
    expect(compareSantim(1, 2)).toBe(-1);
    expect(compareSantim(2, 2)).toBe(0);
    expect(compareSantim(3, 2)).toBe(1);
    expect(equalsSantim(250, 250)).toBe(true);
    expect(equalsSantim(250, 251)).toBe(false);
  });

  test("availability is a pure check, never a mutation", () => {
    expect(hasAvailableSantim(500, 499)).toBe(true);
    expect(hasAvailableSantim(500, 500)).toBe(true);
    expect(hasAvailableSantim(500, 501)).toBe(false);
    expect(hasAvailableSantim(0, 0)).toBe(true);
  });

  test("type guards behave", () => {
    expect(isNonNegativeSantim(0)).toBe(true);
    expect(isPositiveSantim(1)).toBe(true);
    expect(isNonNegativeSantim(-1)).toBe(false);
    expect(isPositiveSantim(0.5)).toBe(false);
  });
});

describe("formatSantimAsBirr", () => {
  test("formats integer santims to a two-decimal birr string", () => {
    expect(formatSantimAsBirr(12500)).toBe("125.00");
    expect(formatSantimAsBirr(5)).toBe("0.05");
    expect(formatSantimAsBirr(50)).toBe("0.50");
    expect(formatSantimAsBirr(0)).toBe("0.00");
    expect(formatSantimAsBirr(1000000000)).toBe("10000000.00");
  });

  test("returns null for invalid input", () => {
    expect(formatSantimAsBirr(-1)).toBe(null);
    expect(formatSantimAsBirr(0.5)).toBe(null);
  });
});
