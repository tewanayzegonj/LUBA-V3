/**
 * LUBA V1 — phone normalization/validation (pure, deterministic).
 *
 * Produces ONE canonical identity form (E.164, digits only) from the
 * accepted V1 input formats, so `users.phone` holds exactly one shape and
 * `by_phone` uniqueness is meaningful. Never logs, never touches OTP
 * material, contains no provider credentials.
 *
 * The country policy lives in `PHONE_POLICY` below — the SINGLE point to
 * adjust if the final numbering policy changes (TRD §4 keeps the exact
 * policy adjustable; nothing else in the codebase hardcodes ET specifics).
 *
 * V1 is Ethiopia-first (PRD frozen): only +251 mobile numbers are accepted
 * as identities. Other regions are rejected with `unsupported_region` —
 * this is a policy gate, not a hard technical limit.
 */

export type PhoneRejection =
  | "empty"
  | "bad_characters"
  | "unsupported_region"
  | "invalid_length"
  | "not_mobile_number";

/**
 * V1 numbering policy (Ethiopia-first). Adjust HERE only when policy changes:
 *  - `countryCallingCode: "251"` — Ethiopia
 *  - `trunkPrefix: "0"` — local trunk prefix stripped during normalization
 *  - `nationalSignificantLength: 9` — mobile national significant number
 *  - `mobilePrefixes: ["9", "7"]` — Ethio Telecom (9xx) and Safaricom
 *    Ethiopia (7xx) mobile ranges; landlines (11xx…) are not identities.
 */
export const PHONE_POLICY = {
  defaultCountry: "ET",
  countryCallingCode: "251",
  trunkPrefix: "0",
  nationalSignificantLength: 9,
  mobilePrefixes: ["9", "7"],
} as const;

function fail(reason: PhoneRejection): { ok: false; reason: PhoneRejection } {
  return { ok: false, reason };
}

function ok(canonical: string): { ok: true; canonical: string } {
  return { ok: true, canonical };
}

/** Characters tolerated as formatting separators inside a phone input. */
const SEPARATORS = /[\s().\-–—]/g;

/**
 * Normalize a phone input to the canonical E.164 identity form.
 *
 * Accepted input shapes (all → `+2519XXXXXXXX` for a 9xx/7xx mobile):
 *  - E.164: `+251911234567`, `+251 911 234 567`
 *  - international without `+`: `251911234567`, `00251911234567`
 *  - local with trunk prefix: `0911234567`, `0911-234-567`
 *  - bare national significant number: `911234567`
 *
 * Deterministic and side-effect-free. Never logs the input.
 */
export function normalizePhoneInput(
  input: string,
): { ok: true; canonical: string } | { ok: false; reason: PhoneRejection } {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed.length === 0) return fail("empty");

  // International detection: leading `+` or `00` prefix.
  const international = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.startsWith("+")
    ? trimmed.slice(1)
    : trimmed.startsWith("00")
      ? trimmed.slice(2)
      : trimmed;

  digits = digits.replace(SEPARATORS, "");
  if (!/^\d*$/.test(digits)) return fail("bad_characters");
  if (digits.length === 0) return fail("empty");

  const { countryCallingCode, trunkPrefix, nationalSignificantLength, mobilePrefixes } =
    PHONE_POLICY;

  let national: string;
  // Bare country-code form (e.g. "251911234567" without +/00): unambiguous in
  // ET — local numbers never reach this length — so it is treated as
  // international. Any other bare-prefixed number stays a (invalid) local
  // input; only +/00-prefixed inputs declare a foreign country code.
  const bareCcForm =
    !international &&
    digits.startsWith(countryCallingCode) &&
    (digits.length === countryCallingCode.length + nationalSignificantLength ||
      digits.length === countryCallingCode.length + nationalSignificantLength + 1);
  if (international || bareCcForm) {
    if (!digits.startsWith(countryCallingCode)) return fail("unsupported_region");
    national = digits.slice(countryCallingCode.length);
  } else {
    national = digits;
  }
  // Country-code / local forms may carry the trunk prefix (09…, 25109…).
  if (national.length === nationalSignificantLength + 1 && national.startsWith(trunkPrefix)) {
    national = national.slice(1);
  }

  if (national.length !== nationalSignificantLength) return fail("invalid_length");
  if (!mobilePrefixes.some((prefix) => national.startsWith(prefix))) {
    return fail("not_mobile_number");
  }

  return ok(`+${countryCallingCode}${national}`);
}

/** True iff two raw inputs resolve to the same canonical identity. */
export function isSamePhoneIdentity(a: string, b: string): boolean {
  const na = normalizePhoneInput(a);
  const nb = normalizePhoneInput(b);
  return na.ok && nb.ok && na.canonical === nb.canonical;
}

/**
 * Deterministic display mask for a canonical E.164 phone: country code and
 * last three digits visible, the rest masked. Used on self-profile surfaces
 * (shoulder-surfing/session-hijack minimization; the full number is never
 * rendered client-side).
 */
export function maskPhone(canonical: string): string {
  const match = /^\+(\d{1,3})(\d+)$/.exec(canonical);
  if (!match) return "•••••";
  const [, countryCode, national] = match;
  const visible = national.slice(-3);
  const masked = "•".repeat(Math.max(national.length - 3, 0));
  return `+${countryCode}${masked}${visible}`;
}
