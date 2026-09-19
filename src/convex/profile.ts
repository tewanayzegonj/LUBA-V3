/**
 * LUBA V1 — identity/profile Convex functions (Phase C foundation).
 *
 * Thin transactional wrappers ONLY: every function delegates authorization
 * to the Phase B guards (`requireAuthenticated` / `requireOperator`) and
 * decisions to the pure modules (`domain/identity.ts`, `domain/phone.ts`).
 * No authorization or business logic is duplicated here.
 *
 * Provider-neutral boundary (TRD §4): these functions define the identity
 * layer around which the (still OPEN) phone-OTP provider will wrap. The
 * template auth files remain do-not-modify; no OTP is generated, sent, or
 * verified here, and no provider credentials exist in this codebase.
 *
 * Scope: self-profile read/patch + the registration defaults boundary.
 * Role enforcement uses the frozen two-class contract; no operator console.
 */
import { v } from "convex/values";

import {
  decideProvision,
  projectSelfProfile,
  validateProfilePatch,
  type ProfilePatchInput,
} from "./domain/identity";
import { normalizePhoneInput } from "./domain/phone";
import { requireAuthenticated } from "./guards/auth";
import { internalMutation, mutation, query } from "./_generated/server";

/* ── Self profile (owner-only view) ── */

/**
 * The signed-in user's own profile projection. Unauthenticated callers get
 * the uniform `unauthenticated` rejection (anti-enumeration; safe failure).
 */
export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const auth = await requireAuthenticated(ctx);
    if (!auth.ok) return { ok: false as const, reason: auth.reason };
    const user = await ctx.db.get(auth.value.userId);
    if (user === null) return { ok: false as const, reason: "unauthenticated" as const };
    return { ok: true as const, profile: projectSelfProfile(user) };
  },
});

/* ── Profile patch (the only consent writer in V1) ── */

/**
 * Update the caller's own editable profile fields. FROZEN semantics:
 *  - `publicWinnerConsent` is a plain boolean; only this path writes it;
 *    winning never implies consent and no other code path can set it.
 *  - `publicDisplayName: null` withdraws the public name (consent without a
 *    name publishes nothing — enforced again at every publication point).
 *  - `phone`, `phoneVerified`, and `role` are NOT patchable here.
 *
 * No-op patches are rejected (`no_changes`) so writes stay meaningful.
 */
export const updateMyProfile = mutation({
  args: {
    displayName: v.optional(v.union(v.string(), v.null())),
    publicDisplayName: v.optional(v.union(v.string(), v.null())),
    publicWinnerConsent: v.optional(v.boolean()),
    preferredLanguage: v.optional(v.union(v.literal("en"), v.literal("am"))),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthenticated(ctx);
    if (!auth.ok) return { ok: false as const, reason: auth.reason };
    const user = await ctx.db.get(auth.value.userId);
    if (user === null) return { ok: false as const, reason: "unauthenticated" as const };

    // Map validator args to the patch input: absent (undefined) fields are
    // not part of the patch; explicit nulls mean "clear".
    const input: ProfilePatchInput = {};
    if (args.displayName !== undefined) input.displayName = args.displayName;
    if (args.publicDisplayName !== undefined) input.publicDisplayName = args.publicDisplayName;
    if (args.publicWinnerConsent !== undefined) input.publicWinnerConsent = args.publicWinnerConsent;
    if (args.preferredLanguage !== undefined) input.preferredLanguage = args.preferredLanguage;

    const result = validateProfilePatch(user, input);
    if (!result.ok) return { ok: false as const, reason: result.reason };

    // Map the validated patch to a Convex patch. `users` fields are optional
    // (string | undefined), so "clear" semantics (null / undefined) are
    // expressed by OMITTING the field — Convex removes it from the document.
    const dbPatch: {
      displayName?: string;
      publicDisplayName?: string;
      publicWinnerConsent?: boolean;
      preferredLanguage?: "en" | "am";
    } = {};
    const patch = result.patch;
    if ("displayName" in patch) dbPatch.displayName = patch.displayName; // undefined = clear (field removed)
    if ("publicDisplayName" in patch) {
      dbPatch.publicDisplayName = patch.publicDisplayName ?? undefined; // null → clear
    }
    if (patch.publicWinnerConsent !== undefined) {
      dbPatch.publicWinnerConsent = patch.publicWinnerConsent;
    }
    if (patch.preferredLanguage !== undefined) {
      dbPatch.preferredLanguage = patch.preferredLanguage;
    }

    await ctx.db.patch(auth.value.userId, dbPatch);
    const updated = await ctx.db.get(auth.value.userId);
    if (updated === null) return { ok: false as const, reason: "unauthenticated" as const };
    return { ok: true as const, profile: projectSelfProfile(updated) };
  },
});

/* ── Registration defaults boundary (identity provisioning) ── */

/**
 * Provision-or-find the LUBA identity for a phone input. This is the
 * provider-neutral entry point the future OTP flow will call AFTER
 * verification succeeds (verification mechanics stay OPEN — TRD §4):
 *  - no user holds the canonical phone → insert with `lubaIdentityDefaults`
 *    (phoneVerified false, consent false, language en, role user);
 *  - exactly one user holds it → return that identity;
 *  - more than one → `phone_taken` invariant failure (never merge silently).
 *
 * Uniqueness is enforced transactionally via the `by_phone` index lookup;
 * racing provisioners abort via Convex OCC and retry.
 */
export const ensureLubaIdentity = internalMutation({
  args: { phoneInput: v.string() },
  handler: async (ctx, args) => {
    const normalized = normalizePhoneInput(args.phoneInput);
    if (!normalized.ok) return { ok: false as const, reason: normalized.reason };

    const existing = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", normalized.canonical))
      .collect();

    const decision = decideProvision(normalized.canonical, existing);
    if (!decision.ok) return { ok: false as const, reason: decision.reason };

    if (decision.outcome === "existing") {
      return {
        ok: true as const,
        outcome: "existing" as const,
        userId: decision.userId,
        phoneVerified: (existing[0]?.phoneVerified ?? false) === true,
      };
    }

    const userId = await ctx.db.insert("users", decision.defaults);
    return {
      ok: true as const,
      outcome: "new" as const,
      userId,
      phoneVerified: false,
    };
  },
});
