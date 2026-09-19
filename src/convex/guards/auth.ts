/**
 * LUBA V1 — server-side identity/authorization guards.
 *
 * Two layers ("smallest abstraction that is reusable"):
 *  1. Pure evaluators — decision cores over caller-fetched data. Deterministic,
 *     side-effect-free, unit-testable without a Convex runtime.
 *  2. Thin ctx adapters — resolve identity from a Convex `ctx` (getAuthUserId,
 *     db.get) and delegate to the evaluators. No business logic here.
 *
 * TRD §28: server-side authorization in every function; the client is
 * untrusted. Backend Schema §2/§17: the finalized role model is the frozen
 * two-class `users.role: "user" | "operator"` union — no new roles, no
 * hierarchy (naming/tiers stay OPEN upstream).
 *
 * Safe failure behavior: rejections return stable machine reasons and never
 * echo identity material (no phone numbers, no role names) back to callers.
 */
import type { Doc, Id } from "../_generated/dataModel";

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

/* ── ctx adapters (thin; call the pure evaluators) ──
 * These are import-safe for unit tests because the Convex imports resolve
 * lazily at call time is not needed — the module only references `ctx`
 * structurally, so tests exercise the evaluators instead. */

/**
 * Resolve the signed-in user row for a ctx. Reads `ctx.auth.userId` if
 * present, otherwise delegates to the template's getAuthUserId bridge.
 * Works for both QueryCtx and MutationCtx (structural typing).
 */
export async function resolveUser(
  ctx: { db: unknown } & Record<string, unknown>,
): Promise<Doc<"users"> | null> {
  const authApi = (ctx as { auth?: { getUserId?: () => Promise<Id<"users"> | null> } }).auth;
  if (typeof authApi?.getUserId === "function") {
    const userId = await authApi.getUserId();
    if (userId === null) return null;
    return await (ctx.db as { get: (id: Id<"users">) => Promise<Doc<"users"> | null> }).get(userId);
  }
  // Fallback: the template's documented bridge (getAuthUserId uses ctx.auth
  // internally; reaching here means the caller passed a db-only ctx, which
  // cannot be authenticated).
  return null;
}

/**
 * `requireAuthenticated` — reject unauthenticated callers.
 * Usage: `const { userId } = await requireAuthenticated(ctx);`
 */
export async function requireAuthenticated(
  ctx: Parameters<typeof resolveUser>[0],
): Promise<GuardResult<{ userId: Id<"users"> }>> {
  return evaluateAuthenticatedUser(await resolveUser(ctx));
}

/**
 * `requireVerifiedPhoneUser` — reject unauthenticated callers and callers
 * whose phone is missing or not verified (fail-closed; frozen gate).
 */
export async function requireVerifiedPhoneUser(
  ctx: Parameters<typeof resolveUser>[0],
): Promise<GuardResult<{ userId: Id<"users"> }>> {
  return evaluateVerifiedPhoneUser(await resolveUser(ctx));
}

/**
 * `requireOperator` — reject anyone without the frozen `operator` role.
 * Regular users can never perform operator actions.
 */
export async function requireOperator(
  ctx: Parameters<typeof requireAuthenticated>[0],
): Promise<GuardResult<{ userId: Id<"users"> }>> {
  return evaluateOperator(await resolveUser(ctx));
}
