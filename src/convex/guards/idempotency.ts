/**
 * LUBA V1 — idempotency foundation over `idempotencyRecords`.
 *
 * Backend Schema §13 / TRD §16: every economic operation references a unique
 * idempotency key; replay returns the original outcome with zero economic
 * effect; a changed request must NEVER silently reuse the original key.
 *
 * Layers:
 *  1. Pure helpers — key derivation (op + user binding + client token),
 *     request fingerprinting, replay classification, outcome envelope.
 *  2. Thin ctx functions — `checkIdempotencyKey` / `commitIdempotencyKey`
 *     running inside the caller's transaction (Convex OCC makes the
 *     check→effect→commit span atomic within one mutation).
 *
 * The user binding is part of the key itself: the same client token from a
 * different user is a DIFFERENT key, so cross-user replay is structurally
 * impossible.
 *
 * Scope note: mechanism only. Bidding/payments/refunds/settlement call this
 * later; nothing here performs any economic effect.
 */
import { IDEMPOTENCY_OPS, type IdempotencyOp } from "../domain/contracts";

/* ── Pure helpers ── */

export type IdempotencyKeyParts = {
  op: IdempotencyOp;
  /** Owning user id (string form) or null for system/sweeps. */
  userId: string | null;
  /** Client-supplied idempotency token for this logical operation attempt. */
  clientToken: string;
};

/**
 * Derive the canonical idempotency key. Throws on programmer errors (unknown
 * op, empty token) — these are internal invariant violations, not user
 * rejections, and must never surface as silent key collisions.
 */
export function deriveIdempotencyKey(parts: IdempotencyKeyParts): string {
  if (!(IDEMPOTENCY_OPS as readonly string[]).includes(parts.op)) {
    throw new Error(`invalid idempotency op: ${String(parts.op)}`);
  }
  if (typeof parts.clientToken !== "string" || parts.clientToken.length === 0) {
    throw new Error("idempotency clientToken must be a non-empty string");
  }
  const owner = parts.userId ?? "system";
  return `luba:idem:${parts.op}:${owner}:${parts.clientToken}`;
}

/**
 * Deterministic canonical JSON: object keys sorted recursively so equal
 * request payloads always fingerprint identically. Arrays preserve order.
 * `undefined` values and functions are dropped by JSON.stringify semantics.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Request fingerprint: a deterministic replay identity over the operation's
 * semantic payload. The caller chooses what belongs in the payload (business
 * fields only — never credentials, never tokens). Equal payloads → equal
 * fingerprints; any change → different fingerprint → conflict.
 */
export function fingerprintRequest(payload: unknown): string {
  return canonicalJson(payload);
}

/** Outcome envelope stored in `idempotencyRecords.outcome`. */
export type StoredOutcome = { fp: string; outcome: string };

export function encodeOutcome(fingerprint: string, outcome: string): string {
  return JSON.stringify({ v: 1, fp: fingerprint, outcome } satisfies StoredOutcome & { v: number });
}

/** Decode a stored outcome envelope; null if it is not envelope-shaped. */
export function decodeOutcome(stored: string): StoredOutcome | null {
  try {
    const parsed = JSON.parse(stored) as { v?: number; fp?: string; outcome?: string };
    if (parsed?.v === 1 && typeof parsed.fp === "string" && typeof parsed.outcome === "string") {
      return { fp: parsed.fp, outcome: parsed.outcome };
    }
    return null;
  } catch {
    return null;
  }
}

/** Compare a replay's fingerprint against the stored one. */
export function classifyReplay(
  storedFingerprint: string,
  currentFingerprint: string,
): "match" | "conflict" {
  return storedFingerprint === currentFingerprint ? "match" : "conflict";
}

/* ── Thin ctx functions ──
 * Structural db shape used by these helpers (cast internally from `unknown`
 * so real MutationCtx/QueryCtx and test fakes both fit). */

type IdemDoc = {
  _id: string;
  key: string;
  op: string;
  refType: string;
  refId: string;
  outcome: string; // JSON envelope
  createdAt: number;
};

type KeyQuery = { eq: (field: string, value: string) => unknown };
type IndexedQuery = {
  withIndex: (
    name: string,
    fn: (q: KeyQuery) => unknown,
  ) => { unique: () => Promise<IdemDoc | null> };
};

type IdempotencyDb = {
  query: (table: "idempotencyRecords") => IndexedQuery;
  insert: (
    table: "idempotencyRecords",
    doc: {
      key: string;
      op: string;
      refType: string;
      refId: string;
      outcome: string;
      createdAt: number;
    },
  ) => Promise<string>;
};

export type IdempotencyCtx = { db: unknown };

export type IdempotencyCheckInput = {
  key: string;
  fingerprint: string;
};

export type IdempotencyCheckResult =
  | { status: "new" }
  | { status: "replay"; outcome: string; refType: string; refId: string }
  | { status: "conflict" };

/**
 * Check a key at the top of a mutation.
 *  - `new`: safe to perform the economic effect, then commit.
 *  - `replay`: return `outcome` verbatim; perform ZERO economic effect.
 *  - `conflict`: the key exists but the request fingerprint differs — a
 *    changed request tried to reuse the original key. Refuse.
 */
export async function checkIdempotencyKey(
  ctx: IdempotencyCtx,
  input: IdempotencyCheckInput,
): Promise<IdempotencyCheckResult> {
  const db = ctx.db as IdempotencyDb;
  const existing = await db
    .query("idempotencyRecords")
    .withIndex("by_key", (q: KeyQuery) => q.eq("key", input.key))
    .unique();
  if (existing === null) return { status: "new" };
  const stored = decodeOutcome(existing.outcome);
  if (stored !== null && classifyReplay(stored.fp, input.fingerprint) === "conflict") {
    return { status: "conflict" };
  }
  return {
    status: "replay",
    outcome: stored !== null ? stored.outcome : existing.outcome,
    refType: existing.refType,
    refId: existing.refId,
  };
}

export type IdempotencyCommitInput = {
  key: string;
  op: IdempotencyOp;
  userId: string | null;
  fingerprint: string;
  /** Outcome entity table name (e.g. "bids", "ledgerEntries"). */
  refType: string;
  /** Outcome entity id (string form). */
  refId: string;
  /** Original result to return verbatim on replay (machine-readable). */
  outcome: string;
};

/**
 * Commit the key in the SAME transaction as the economic effect. If the
 * transaction aborts, neither the effect nor the key exists — exactly-once.
 */
export async function commitIdempotencyKey(
  ctx: IdempotencyCtx,
  input: IdempotencyCommitInput,
): Promise<void> {
  const db = ctx.db as IdempotencyDb;
  await db.insert("idempotencyRecords", {
    key: input.key,
    op: input.op,
    refType: input.refType,
    refId: input.refId,
    outcome: encodeOutcome(input.fingerprint, input.outcome),
    createdAt: Date.now(),
  });
}
