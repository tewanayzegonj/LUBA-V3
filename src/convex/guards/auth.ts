/**
 * LUBA V1 — server-side identity/authorization guards.
 *
 * Two layers ("smallest abstraction that is reusable"):
 *  1. Pure evaluators — decision cores over caller-fetched data. Deterministic,
 *     side-effect-free, unit-testable without a Convex runtime.
 *  2. Thin ctx adapters — resolve identity from a Convex `ctx` and delegate
 *     to the evaluators. No business logic here.
 *
 * TRD §28: server-side authorization in every function; the client is
 * untrusted. Backend Schema §2/§17: the finalized role model is the frozen
 * two-class `users.role: "user" | "operator"` union — no new roles, no
 * hierarchy (naming/tiers stay OPEN upstream).
 *
 * Safe failure behavior: rejections return stable machine reasons and never
 * echo identity material (no phone numbers, no role names) back to callers.
 *
 * Identity boundary note (Phase C): `resolveUser` is the single server-side
 * user-lookup boundary. The Convex Auth template files (auth.config.ts,
 * auth.ts, auth/emailOtp.ts) remain do-not-modify; the SMS/OTP provider
 * decision stays OPEN (TRD §4) and does not affect this boundary.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

import { requireVerifiedPhone } from "../domain/rules";

/* ── Shared rejection vocabulary for guard failures ──
 * `unauthenticated` is deliberately indistinguishable between "no session"
 * and "session without a user row" so sessions cannot probe for dangling
 * auth identities (TRD §28: uniform responses prevent enumeration). */
export type AuthGuardRejection =
  | "unauthenticated"
  | "unverified_phone"
  | "phone_missing"
  | "not_authorized";

export type GuardOk<T> = { ok: true; value: T };
export type GuardRejection = { ok: false; reason: AuthGuardRejection };
export type GuardResult<T> = GuardOk<T> | GuardRejection;

/**
 * Identity resolution runs on a real Convex Query/Mutation ctx. The type is
 * composed structurally — the template's documented auth bridge
 * (`getAuthUserId`) for session resolution, plus the generated db reader —
 * so adapters always compile against the real ctx, with no parallel shape
 * to maintain and no divergence between tests and production.
 */
export type IdentityCtx = {
  auth: Parameters<typeof getAuthUserId>[0]["auth"];
  db: QueryCtx["db"];
};

/* ── Pure evaluators (unit-testable cores) ── */

/** Shared auth core: null-safe over an absent user row; returns the row. */
function authenticatedUser(user: Doc<"users"> | null): GuardResult<Doc<"users">> {
  if (user === null) return { ok: false, reason: "unauthenticated" };
  return { ok: true, value: user };
}

/** Core of `requireAuthenticated`: null-safe over an absent user row. */
export function evaluateAuthenticatedUser(
  user: Doc<"users"> | null,
): GuardResult<{ userId: Id<"users"> }> {
  const auth = authenticatedUser(user);
  if (!auth.ok) return auth;
  return { ok: true, value: { userId: auth.value._id } };
}

/** Core of `requireVerifiedPhoneUser`: fail-closed phone gate (frozen). */
export function evaluateVerifiedPhoneUser(
  user: Doc<"users"> | null,
): GuardResult<{ userId: Id<"users"> }> {
  const auth = authenticatedUser(user);
  if (!auth.ok) return auth;
  const phoneGate = requireVerifiedPhone({
    phone: auth.value.phone,
    phoneVerified: auth.value.phoneVerified,
  });
  if (!phoneGate.ok) {
    // Map the domain reasons onto the guard vocabulary without echoing them.
    return {
      ok: false,
      reason: phoneGate.reason === "phone_missing" ? "phone_missing" : "unverified_phone",
    };
  }
  return { ok: true, value: { userId: auth.value._id } };
}

/** Core of `requireOperator`: the frozen two-class role model, fail-closed. */
export function evaluateOperator(
  user: Doc<"users"> | null,
): GuardResult<{ userId: Id<"users"> }> {
  const auth = authenticatedUser(user);
  if (!auth.ok) return auth;
  if (auth.value.role !== "operator") return { ok: false, reason: "not_authorized" };
  return { ok: true, value: { userId: auth.value._id } };
}

/** Core of `requireOwnership`: exact equality over typed user IDs. */
export function evaluateOwnership(
  callerId: Id<"users">,
  resourceOwnerId: Id<"users">,
): GuardResult<{ callerId: Id<"users"> }> {
  if (callerId !== resourceOwnerId) return { ok: false, reason: "not_authorized" };
  return { ok: true, value: { callerId } };
}

/** Core of "owner OR operator" access (e.g. support views). */
export function evaluateOwnerOrOperator(
  callerId: Id<"users">,
  resourceOwnerId: Id<"users">,
  isOperator: boolean,
): GuardResult<{ callerId: Id<"users"> }> {
  if (callerId === resourceOwnerId) return { ok: true, value: { callerId } };
  if (isOperator) return { ok: true, value: { callerId } };
  return { ok: false, reason: "not_authorized" };
}

/* ── ctx adapters (thin; call the pure evaluators) ── */

/**
 * Resolve the signed-in user row for a ctx — the single server-side
 * identity-lookup boundary. Uses the template's documented Convex Auth
 * bridge (`getAuthUserId`): a session maps to its users row; a session
 * without a matching user row resolves to null (guarded as
 * `unauthenticated` upstream — never leaked as a distinct state).
 */
export async function resolveUser(ctx: IdentityCtx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

/**
 * `requireAuthenticated` — reject unauthenticated callers.
 * Usage: `const { userId } = await requireAuthenticated(ctx);`
 */
export async function requireAuthenticated(
  ctx: IdentityCtx,
): Promise<GuardResult<{ userId: Id<"users"> }>> {
  return evaluateAuthenticatedUser(await resolveUser(ctx));
}

/**
 * `requireVerifiedPhoneUser` — reject unauthenticated callers and callers
 * whose phone is missing or not verified (fail-closed; frozen gate).
 */
export async function requireVerifiedPhoneUser(
  ctx: IdentityCtx,
): Promise<GuardResult<{ userId: Id<"users"> }>> {
  return evaluateVerifiedPhoneUser(await resolveUser(ctx));
}

/**
 * `requireOperator` — reject anyone without the frozen `operator` role.
 * Regular users can never perform operator actions.
 */
export async function requireOperator(
  ctx: IdentityCtx,
): Promise<GuardResult<{ userId: Id<"users"> }>> {
  return evaluateOperator(await resolveUser(ctx));
}
