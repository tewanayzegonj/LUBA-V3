/**
 * LUBA V1 — audit foundation over `auditEvents`.
 *
 * Backend Schema §14 / TRD §20: every economic op, lifecycle transition,
 * inventory operation, anti-snipe extension, privileged action, and
 * notification send writes one row in the same transaction as the effect.
 * Append-only; never user-exposed; operator-readable.
 *
 * The sanitizer enforces PII/secret minimization mechanically: forbidden keys
 * (secrets, OTPs, credentials, receipt URLs, auth headers, raw payloads,
 * direct PII) are stripped recursively, sizes capped, only JSON-safe values
 * kept. A careless future call site cannot leak sensitive material through
 * `meta`.
 *
 * Scope note: recording mechanism only — Phase D+ economic mutations call
 * this inside their transactions; nothing here mutates business state.
 */

import { isAuditAction, type ActorRole, type AuditAction } from "../domain/contracts";
import { isPositiveSantim } from "../domain/money";

/* ── Safe metadata ──
 * Minimum approved metadata: actor attribution, action class, entity
 * reference, server timestamp, safe structured metadata. Everything else is
 * mechanically stripped. */

const FORBIDDEN_META_KEYS = [
  // secrets / credentials / tokens
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "authheader",
  "cookie",
  "signature",
  // OTP material — generic `code` is ambiguous, so it is stripped; use a
  // specific key such as `auctionCode` (public information) instead.
  "otp",
  "otpcodes",
  "verificationcode",
  "code",
  // payment credentials / provider artifacts
  "cardnumber",
  "pan",
  "cvv",
  "cvc",
  "expiry",
  "receipturl",
  "paymentcredential",
  // raw request payloads / direct PII carriers
  "payload",
  "body",
  "rawrequest",
  "headers",
  "phone",
  "phonenumber",
  "email",
  "address",
  "deliveryaddress",
  "ip",
  "ipaddress",
];

const MAX_META_DEPTH = 4;
const MAX_META_STRING = 200;
const MAX_META_ARRAY = 16;

/** Normalize a key for the forbidden check (case/underscore/hyphen-insensitive). */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

type SanitizedValue = { included: boolean; value: unknown };

function sanitizeMetaValue(value: unknown, depth: number): SanitizedValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { included: true, value };
  }
  if (typeof value === "string") {
    return {
      included: true,
      value: value.length > MAX_META_STRING ? `${value.slice(0, MAX_META_STRING - 3)}...` : value,
    };
  }
  if (typeof value !== "object" || depth >= MAX_META_DEPTH) {
    return { included: false, value: undefined };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, MAX_META_ARRAY)) {
      const result = sanitizeMetaValue(item, depth + 1);
      if (result.included) items.push(result.value);
    }
    return { included: items.length > 0, value: items };
  }
  const obj: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_META_KEYS.includes(normalizeKey(key))) continue; // mechanically stripped
    if (typeof child === "function" || child === undefined) continue;
    const result = sanitizeMetaValue(child, depth + 1);
    if (result.included) obj[key] = result.value;
  }
  return { included: Object.keys(obj).length > 0, value: obj };
}

/**
 * Recursively sanitize audit metadata for storage in `auditEvents.meta`.
 * Returns undefined when nothing safe remains. Auction/bid public reference
 * codes belong under a specific key such as `auctionCode` (a generic `code`
 * key is stripped because of OTP ambiguity).
 */
export function sanitizeAuditMeta(
  input: unknown,
): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const result = sanitizeMetaValue(input, 0);
  if (!result.included) return undefined;
  return typeof result.value === "object" && result.value !== null && !Array.isArray(result.value)
    ? (result.value as Record<string, unknown>)
    : undefined;
}

/* ── Pure input evaluation ──
 * Closed action vocabulary (contracts.AUDIT_ACTIONS), actor attribution
 * rules, entity reference shape, and positive-integer santim amounts. */

export type AuditEventInput = {
  /** User id (string form) or null for system/sweeps. */
  actorId: string | null;
  actorRole: ActorRole;
  action: string;
  entityType: string;
  entityId: string;
  /** Correlation with an idempotency key when the audited op has one. */
  idempotencyKey?: string | null;
  /** Integer santims when the audited op is financial. */
  amountSantim?: number | null;
  /** Candidate metadata; sanitized before storage. */
  meta?: unknown;
};

export type AuditEventRejection =
  | "invalid_action"
  | "invalid_actor"
  | "invalid_entity"
  | "invalid_amount";

export type EvaluatedAuditEvent = {
  actorId: string | null;
  actorRole: ActorRole;
  action: AuditAction;
  entityType: string;
  entityId: string;
  idempotencyKey: string | undefined;
  amountSantim: number | undefined;
  meta: Record<string, unknown> | undefined;
};

export type AuditEvaluation =
  | { ok: true; event: EvaluatedAuditEvent }
  | { ok: false; reason: AuditEventRejection };

/** Evaluate audit input without touching any ctx. Deterministic. */
export function evaluateAuditEvent(input: AuditEventInput): AuditEvaluation {
  if (!isAuditAction(input.action)) return { ok: false, reason: "invalid_action" };

  if (input.actorRole === "user" || input.actorRole === "operator") {
    if (input.actorId === null || input.actorId.length === 0) {
      return { ok: false, reason: "invalid_actor" };
    }
  }

  if (typeof input.entityType !== "string" || input.entityType.length === 0) {
    return { ok: false, reason: "invalid_entity" };
  }
  if (typeof input.entityId !== "string" || input.entityId.length === 0) {
    return { ok: false, reason: "invalid_entity" };
  }

  if (input.amountSantim !== undefined && input.amountSantim !== null) {
    if (!isPositiveSantim(input.amountSantim)) return { ok: false, reason: "invalid_amount" };
  }

  const meta = sanitizeAuditMeta(input.meta);
  return {
    ok: true,
    event: {
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey ?? undefined,
      amountSantim: input.amountSantim ?? undefined,
      meta,
    },
  };
}

/* ── ctx wrapper ── */

type AuditDb = {
  insert: (
    table: "auditEvents",
    doc: {
      actorId: string | null;
      actorRole: ActorRole;
      action: AuditAction;
      entityType: string;
      entityId: string;
      idempotencyKey?: string;
      amountSantim?: number;
      meta?: Record<string, unknown>;
      createdAt: number;
    },
  ) => Promise<string>;
};

export type AuditCtx = { db: unknown };

/**
 * Record one audit event inside the caller's transaction. Throws on invalid
 * input: audit is mandatory (Backend Schema §14 FROZEN), so silently
 * skipping a row would violate the invariant — an invalid call is a
 * programmer error and must abort the surrounding transaction.
 */
export async function recordAuditEvent(
  ctx: AuditCtx,
  input: AuditEventInput,
): Promise<void> {
  const evaluated = evaluateAuditEvent(input);
  if (!evaluated.ok) {
    throw new Error(`audit event rejected: ${evaluated.reason}`);
  }
  const db = ctx.db as AuditDb;
  await db.insert("auditEvents", {
    actorId: evaluated.event.actorId,
    actorRole: evaluated.event.actorRole,
    action: evaluated.event.action,
    entityType: evaluated.event.entityType,
    entityId: evaluated.event.entityId,
    idempotencyKey: evaluated.event.idempotencyKey,
    amountSantim: evaluated.event.amountSantim,
    meta: evaluated.event.meta,
    createdAt: Date.now(),
  });
}
