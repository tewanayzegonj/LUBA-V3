/**
 * LUBA V1 — identity/profile logic (pure decision cores).
 *
 * Phase C identity foundation. Pure functions only: no ctx, no db, no I/O.
 * The Convex functions in `profile.ts` wrap these inside transactions and
 * reuse the Phase B guards — authorization is never duplicated here.
 *
 * FROZEN rules implemented (Backend Schema §2 / PRD):
 *  - `publicWinnerConsent` defaults to FALSE; winning never implies consent;
 *    this module's profile path is the only consent writer in V1.
 *  - `preferredLanguage` defaults to "en".
 *  - `publicDisplayName` is nullable and published only WITH consent.
 *  - `role` defaults to "user"; no code path creates operators.
 *  - One identity per verified phone: `by_phone` uniqueness enforced via
 *    indexed lookup guard (Convex has no native unique indexes).
 *  - Self projection never exposes internal auth/provider fields or raw PII
 *    beyond the frozen display needs (phone is masked).
 */
import type { Doc } from "../_generated/dataModel";

import { maskPhone, normalizePhoneInput } from "./phone";

/* ── Registration defaults ── */

export type LubaIdentityDefaults = {
  phone: string; // canonical E.164
  phoneVerified: false;
  displayName: undefined;
  publicDisplayName: undefined;
  publicWinnerConsent: false;
  preferredLanguage: "en";
  role: "user";
};

/** The exact LUBA identity fields applied when a user row is provisioned. */
export function lubaIdentityDefaults(canonicalPhone: string): LubaIdentityDefaults {
  return {
    phone: canonicalPhone,
    phoneVerified: false,
    displayName: undefined,
    publicDisplayName: undefined,
    publicWinnerConsent: false,
    preferredLanguage: "en",
    role: "user",
  };
}

/* ── New-user vs existing-user boundary ── */

export type ExistingUserLookup = Doc<"users"> | null;

export type ProvisionDecision =
  | { ok: true; outcome: "new"; defaults: LubaIdentityDefaults }
  | { ok: true; outcome: "existing"; userId: Doc<"users">["_id"] }
  | { ok: false; reason: "invalid_phone" | "phone_taken" };

/**
 * Decide how to provision an identity for a canonical phone input.
 *  - `new`: no user holds this phone → apply `lubaIdentityDefaults`.
 *  - `existing`: exactly one user holds it → re-use that identity.
 *  - `phone_taken`: invariant violation — more than one user row matches.
 *    (Convex lacks native unique indexes; `by_phone` + this guard enforce
 *    one-identity-per-phone transactionally. Racing inserts are additionally
 *    prevented by OCC: conflicting transactions abort and retry.)
 */
export function decideProvision(
  canonicalPhone: string,
  existing: ExistingUserLookup[],
): ProvisionDecision {
  const phone = normalizePhoneInput(canonicalPhone);
  if (!phone.ok) return { ok: false, reason: "invalid_phone" };

  // Null rows (if a lookup ever yields one) count as absent.
  const rows = existing.filter((row): row is Doc<"users"> => row !== null);
  if (rows.length === 0) {
    return { ok: true, outcome: "new", defaults: lubaIdentityDefaults(phone.canonical) };
  }
  const [only] = rows;
  if (rows.length === 1 && only !== undefined) {
    return { ok: true, outcome: "existing", userId: only._id };
  }
  // More than one row for one phone is an invariant violation — fail loudly,
  // never merge identities silently.
  return { ok: false, reason: "phone_taken" };
}

/* ── Profile patch validation (the smallest V1 profile surface) ── */

export const EDITABLE_LANGUAGES = ["en", "am"] as const;
export type EditableLanguage = (typeof EDITABLE_LANGUAGES)[number];

export type ProfilePatchInput = {
  displayName?: unknown;
  publicDisplayName?: unknown;
  publicWinnerConsent?: unknown;
  preferredLanguage?: unknown;
};

export type ProfilePatchRejection =
  | "invalid_display_name"
  | "invalid_public_display_name"
  | "invalid_consent"
  | "invalid_language"
  | "empty_patch"
  | "no_changes";

export type ValidProfilePatch = {
  displayName?: string;
  publicDisplayName?: string | null;
  publicWinnerConsent?: boolean;
  preferredLanguage?: EditableLanguage;
};

const MAX_DISPLAY_NAME = 40;
const MAX_PUBLIC_DISPLAY_NAME = 40;

function validDisplayName(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

export type ProfilePatchResult =
  | { ok: true; patch: ValidProfilePatch }
  | { ok: false; reason: ProfilePatchRejection };

/**
 * Validate a profile patch. Every field is optional; at least one must be
 * present. Immutable identity fields (phone, phoneVerified, role) are NOT
 * patchable here — they change only through verification/operator paths.
 * Consent semantics (frozen): `publicWinnerConsent` is a boolean; there is
 * no other writer anywhere in V1.
 */
export function validateProfilePatch(
  current: Pick<
    Doc<"users">,
    "displayName" | "publicDisplayName" | "publicWinnerConsent" | "preferredLanguage"
  >,
  input: ProfilePatchInput,
): ProfilePatchResult {
  const patch: ValidProfilePatch = {};
  let provided = 0;

  if ("displayName" in input) {
    provided += 1;
    const value = input.displayName;
    if (value === null || value === undefined) {
      patch.displayName = undefined; // clearing allowed
    } else if (validDisplayName(value, MAX_DISPLAY_NAME)) {
      patch.displayName = value.trim();
    } else {
      return { ok: false, reason: "invalid_display_name" };
    }
  }

  if ("publicDisplayName" in input) {
    provided += 1;
    const value = input.publicDisplayName;
    if (value === null) {
      patch.publicDisplayName = null; // explicit withdrawal of the public name
    } else if (validDisplayName(value, MAX_PUBLIC_DISPLAY_NAME)) {
      patch.publicDisplayName = value.trim();
    } else {
      return { ok: false, reason: "invalid_public_display_name" };
    }
  }

  if ("publicWinnerConsent" in input) {
    provided += 1;
    if (typeof input.publicWinnerConsent !== "boolean") {
      return { ok: false, reason: "invalid_consent" };
    }
    patch.publicWinnerConsent = input.publicWinnerConsent;
  }

  if ("preferredLanguage" in input) {
    provided += 1;
    const value = input.preferredLanguage;
    if (typeof value === "string" && (EDITABLE_LANGUAGES as readonly string[]).includes(value)) {
      patch.preferredLanguage = value as EditableLanguage;
    } else {
      return { ok: false, reason: "invalid_language" };
    }
  }

  if (provided === 0) return { ok: false, reason: "empty_patch" };

  // No-op suppression: a patch that changes nothing must not write a row
  // (keeps audit trails meaningful — every write is a real change).
  const changesSomething =
    (patch.displayName !== undefined && patch.displayName !== current.displayName) ||
    ("displayName" in patch && patch.displayName === undefined && current.displayName !== undefined) ||
    ("publicDisplayName" in patch &&
      (patch.publicDisplayName ?? null) !== (current.publicDisplayName ?? null)) ||
    (patch.publicWinnerConsent !== undefined &&
      patch.publicWinnerConsent !== (current.publicWinnerConsent ?? false)) ||
    (patch.preferredLanguage !== undefined &&
      patch.preferredLanguage !== (current.preferredLanguage ?? "en"));
  if (!changesSomething) return { ok: false, reason: "no_changes" };

  return { ok: true, patch };
}

/* ── Self projection ── */

export type SelfProfile = {
  userId: string;
  displayName: string | null;
  publicDisplayName: string | null;
  publicWinnerConsent: boolean;
  preferredLanguage: "en" | "am";
  role: "user" | "operator";
  phoneMasked: string;
  phoneVerified: boolean;
  email: string | null;
};

/**
 * Build the owner's own profile view. Structural privacy rules:
 *  - internal user id is exposed ONLY to the owner themself;
 *  - the phone is masked (never rendered raw client-side);
 *  - `phoneVerified` is the one verification flag the owner needs;
 *  - no auth/provider/session internals, no tokens, no raw PII beyond this.
 */
export function projectSelfProfile(user: Doc<"users">): SelfProfile {
  return {
    userId: user._id,
    displayName: user.displayName ?? null,
    publicDisplayName: user.publicDisplayName ?? null,
    publicWinnerConsent: user.publicWinnerConsent ?? false,
    preferredLanguage: user.preferredLanguage ?? "en",
    role: user.role ?? "user",
    phoneMasked: user.phone ? maskPhone(user.phone) : "•••••",
    phoneVerified: user.phoneVerified === true,
    email: user.email ?? null,
  };
}

/**
 * Public display name for winner publication (Q12): published only when the
 * user has BOTH a non-empty public display name AND explicit consent.
 * Winning never implies consent — callers must pass the consent flag
 * explicitly; this function never infers it.
 */
export function publicWinnerName(
  user: Pick<Doc<"users">, "publicDisplayName" | "publicWinnerConsent"> | null,
): string | null {
  if (!user) return null;
  if (user.publicWinnerConsent !== true) return null;
  const name = user.publicDisplayName;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Re-export for boundary consumers (single normalization entry point). */
export { normalizePhoneInput };
