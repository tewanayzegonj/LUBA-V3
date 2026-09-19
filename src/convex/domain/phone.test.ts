import { describe, expect, test } from "bun:test";

import {
  isSamePhoneIdentity,
  maskPhone,
  normalizePhoneInput,
  PHONE_POLICY,
  type PhoneRejection,
} from "./phone";

describe("phone normalization", () => {
  test("accepted formats converge on one canonical E.164 identity form", () => {
    const expected = "+251911234567";
    const accepted = [
      "+251911234567", // E.164
      "+251 911 234 567", // E.164 with separators
      "251911234567", // international without +
      "00251911234567", // 00 international prefix
      "0911234567", // local trunk prefix
      "0911-234-567", // local with separators
      "911234567", // bare national significant number
      " 0911234567 ", // surrounding whitespace
      "+2510911234567", // trunk prefix even after country code
    ];
    for (const input of accepted) {
      const result = normalizePhoneInput(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.canonical).toBe(expected);
    }
  });

  test("Safaricom 7xx mobile range is accepted", () => {
    const result = normalizePhoneInput("0711234567");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canonical).toBe("+251711234567");
  });

  test("invalid inputs are rejected with stable machine reasons", () => {
    const cases: Array<[string, PhoneRejection]> = [
      ["", "empty"],
      ["   ", "empty"],
      ["+251 911 abc 567", "bad_characters"],
      ["0911*234567", "bad_characters"],
      ["+12025550123", "unsupported_region"], // non-251 country code
      ["254712345678", "invalid_length"], // bare non-251 prefix: invalid local under V1's single-country policy
      ["91123456", "invalid_length"], // 8 digits
      ["91123456789", "invalid_length"], // 11 digits
      ["+25191123456789", "invalid_length"],
      ["09112345678", "invalid_length"], // 10 local digits
      ["0111234567", "not_mobile_number"], // landline range (11xx)
      ["+251111234567", "not_mobile_number"],
      ["+999911234567", "unsupported_region"],
    ];
    for (const [input, reason] of cases) {
      const result = normalizePhoneInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  test("canonical identity is stable across equivalent inputs", () => {
    expect(isSamePhoneIdentity("0911234567", "+251 911 234 567")).toBe(true);
    expect(isSamePhoneIdentity("+251911234567", "911234567")).toBe(true);
    expect(isSamePhoneIdentity("0911234567", "0911234568")).toBe(false);
    expect(isSamePhoneIdentity("0911234567", "+12025550123")).toBe(false);
  });

  test("policy is centralized and single-country (adjustable in one place)", () => {
    expect(PHONE_POLICY.countryCallingCode).toBe("251");
    expect(PHONE_POLICY.defaultCountry).toBe("ET");
    expect(PHONE_POLICY.nationalSignificantLength).toBe(9);
    expect(PHONE_POLICY.mobilePrefixes).toEqual(["9", "7"]);
  });

  test("display mask reveals country code and last three digits only", () => {
    expect(maskPhone("+251911234567")).toBe("+251••••••567");
    expect(maskPhone("+251711234567")).toBe("+251••••••567");
    expect(maskPhone("not-a-phone")).toBe("•••••");
  });
});
