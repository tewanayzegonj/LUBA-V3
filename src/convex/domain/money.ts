/**
 * LUBA V1 — pure money primitives (integer ETB santims).
 *
 * Implementation Plan Phase B / TRD §29 ("single shared integer-santim
 * module"): no floating-point money, no implicit rounding, no negative
 * balances anywhere, integer santim semantics preserved end-to-end.
 *
 * Everything here is a deterministic, side-effect-free pure function.
 * No OPEN decision (fee, bounds, deadlines) is assumed or defaulted.
 * Formatting is intentionally server-domain basic (santim → birr string for
 * audit/ledger display); locale-aware UI formatting lives in the UI layer.
 */

/** Integer ETB santims. 1 birr = 100 santim. Always a whole number. */
export type Santim = number;

/** Result of a failed validation — reason is a stable machine key, not prose. */
export type MoneyRejection =
  | "not_finite"
  | "not_integer"
  | "negative";

const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function fail(reason: MoneyRejection): { ok: false; reason: MoneyRejection } {
  return { ok: false, reason };
}

function ok<const T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Structural validation of a santim value. `allowZero` admits 0. */
export function validateSantim(
  value: number,
  { allowZero = false }: { allowZero?: boolean } = {},
): { ok: true; value: Santim } | { ok: false; reason: MoneyRejection } {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail("not_finite");
  if (!Number.isInteger(value)) return fail("not_integer");
  const minimum = allowZero ? 0 : 1;
  if (value < minimum) return fail("negative");
  if (value > MAX_SAFE_INTEGER || value < MIN_SAFE_INTEGER) return fail("not_finite");
  return ok(value);
}

/** True iff the value is a structurally valid non-negative santim (0 allowed). */
export function isNonNegativeSantim(value: number): value is Santim {
  return validateSantim(value, { allowZero: true }).ok;
}

/** True iff the value is a structurally valid positive santim (>= 1). */
export function isPositiveSantim(value: number): value is Santim {
  return validateSantim(value).ok;
}

/** Parse user/provider input into an integer santim amount. No rounding, no coercion. */
export function parseSantim(
  input: string | number,
  { allowZero = false }: { allowZero?: boolean } = {},
): { ok: true; value: Santim } | { ok: false; reason: MoneyRejection | "empty" | "bad_format" } {
  if (typeof input === "number") {
    const validated = validateSantim(input, { allowZero });
    return validated.ok ? ok(validated.value) : validated;
  }
  if (typeof input !== "string" || input.trim() === "") return { ok: false, reason: "empty" };
  const trimmed = input.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "bad_format" }; // no decimals, no exponents
  const value = Number(trimmed);
  const validated = validateSantim(value, { allowZero });
  return validated.ok ? ok(validated.value) : validated;
}

/** Exact addition of two non-negative santim amounts. */
export function addSantim(a: Santim, b: Santim): { ok: true; value: Santim } | { ok: false; reason: MoneyRejection } {
  const va = validateSantim(a, { allowZero: true });
  if (!va.ok) return va;
  const vb = validateSantim(b, { allowZero: true });
  if (!vb.ok) return vb;
  const sum = va.value + vb.value;
  return validateSantim(sum, { allowZero: true });
}

/**
 * Exact subtraction `a - b`. Succeeds only when the result is >= 0 —
 * a subtraction that would go negative is refused, never clamped or floored.
 */
export function subtractSantim(
  a: Santim,
  b: Santim,
): { ok: true; value: Santim } | { ok: false; reason: MoneyRejection } {
  const va = validateSantim(a, { allowZero: true });
  if (!va.ok) return va;
  const vb = validateSantim(b, { allowZero: true });
  if (!vb.ok) return vb;
  if (vb.value > va.value) return fail("negative");
  return ok(va.value - vb.value);
}

/** Exact sum of many non-negative santim amounts. */
export function sumSantim(
  amounts: readonly Santim[],
): { ok: true; value: Santim } | { ok: false; reason: MoneyRejection } {
  let total: Santim = 0;
  for (const amount of amounts) {
    const next = addSantim(total, amount);
    if (!next.ok) return next;
    total = next.value;
  }
  return ok(total);
}

/** True iff `a - b >= 0` — an availability check, never a mutation. */
export function hasAvailableSantim(a: Santim, b: Santim): boolean {
  return subtractSantim(a, b).ok;
}

/** Exact integer comparison. */
export function compareSantim(a: Santim, b: Santim): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function equalsSantim(a: Santim, b: Santim): boolean {
  return a === b;
}

export function isZeroSantim(a: Santim): boolean {
  return a === 0;
}

/**
 * Basic display form: integer santims → birr string with two decimals.
 * Display-only division by 100 for audit/ledger surfaces; stored values are
 * never transformed. Locale-aware UI formatting stays in the UI layer.
 */
export function formatSantimAsBirr(santim: Santim): string | null {
  if (!isNonNegativeSantim(santim)) return null;
  const birr = Math.trunc(santim / 100);
  const remainder = santim - birr * 100;
  return `${birr}.${remainder < 10 ? "0" : ""}${remainder}`;
}
