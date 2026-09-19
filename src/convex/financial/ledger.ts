/**
 * LUBA V1 — financial ledger primitive (server-side, Phase D).
 *
 * The single append-only journal writer. Wraps the pure rules
 * (`domain/ledger.ts`) inside the caller's transaction with the Phase B
 * idempotency and audit foundations. Economic consumers (deposit, bid fee,
 * settlement, refund, withdrawal) call this — none exist yet.
 *
 * Sequence inside the caller's transaction:
 *   1. pure evaluation (balance, accounts, amounts, provenance)
 *   2. idempotency check — replay returns the original outcome, conflict refuses
 *   3. append-only inserts (1 entry + N postings, no updates, no deletes)
 *   4. idempotency commit + audit row, same transaction as the effect
 *
 * Invariants (FROZEN unless noted):
 *  - debits === credits per entry (checked in `evaluateLedgerEntry`)
 *  - positive integer santims only; unbalanced/invalid drafts are refused
 *    BEFORE any write — no partial economic effect can exist
 *  - idempotency commit is in the SAME transaction as the effect: any failure
 *    aborts everything (Convex OCC), keeping the journal exactly-once
 *  - `ledgerEntries.idempotencyKey` (by_idempotencyKey) is the doc-level
 *    FROZEN unique index — defense in depth beneath the registry
 *  - provenance tags are stored verbatim (carrier FROZEN; ordering IMPL)
 *  - audit metadata is sanitized by the audit foundation (no secrets,
 *    receipt URLs, OTPs, credentials, raw payloads)
 */
import type { Id } from "../_generated/dataModel";

import type {
  AuditAction,
  IdempotencyOp,
  LedgerEntryKind,
  LedgerRefType,
} from "../domain/contracts";
import { evaluateLedgerEntry, type LedgerEntryDraft } from "../domain/ledger";
import { recordAuditEvent } from "../guards/audit";
import {
  checkIdempotencyKey,
  commitIdempotencyKey,
  deriveIdempotencyKey,
  fingerprintRequest,
} from "../guards/idempotency";

/* ── Structural db shape (real MutationCtx and test fakes both satisfy it) ── */

type EntryInsert = {
  kind: LedgerEntryKind;
  refType: LedgerRefType;
  refId: string;
  idempotencyKey: string;
  createdAt: number;
};

type PostingInsert = {
  entryId: Id<"ledgerEntries">;
  account: string;
  userSide?: Id<"users">;
  direction: "debit" | "credit";
  amountSantim: number;
  provenanceLotIds?: Id<"provenanceLots">[];
  createdAt: number;
};

export type LedgerDb = {
  insert: (
    table: "ledgerEntries" | "ledgerPostings" | "idempotencyRecords" | "auditEvents",
    doc: EntryInsert | PostingInsert | Record<string, unknown>,
  ) => Promise<string>;
  query: (table: "idempotencyRecords") => {
    withIndex: (
      name: "by_key",
      fn: (q: { eq: (field: "key", value: string) => unknown }) => unknown,
    ) => { unique: () => Promise<{ key: string; refType: string; refId: string; outcome: string } | null> };
  };
};

export type LedgerCtx = { db: unknown };

/* ── Input ── */

export type PostLedgerTransactionInput = LedgerEntryDraft & {
  /** Owning user for the idempotency key binding (null for system ops). */
  ownerUserId: Id<"users"> | null;
  /** Stable client/server idempotency token for this logical operation. */
  idempotencyToken: string;
  /** Operation class for the idempotency registry. */
  idempotencyOp: IdempotencyOp;
};

export type PostLedgerTransactionResult =
  | {
      ok: true;
      status: "posted";
      entryId: Id<"ledgerEntries">;
      /** Outcome string returned verbatim on replay. */
      outcome: string;
    }
  | {
      ok: true;
      status: "replay";
      /** Original outcome — the caller returns it verbatim, zero effect. */
      outcome: string;
      entryId: Id<"ledgerEntries"> | null;
    }
  | { ok: false; status: "conflict"; reason: "idempotency_conflict" }
  | {
      ok: false;
      status: "rejected";
      reason:
        | "invalid_kind"
        | "invalid_ref_type"
        | "invalid_ref_id"
        | "invalid_postings"
        | "invalid_posting"
        | "invalid_account"
        | "user_side_required"
        | "user_side_mismatch"
        | "user_side_forbidden"
        | "unbalanced_entry"
        | "provenance_required";
    };

/**
 * The journal entry's audit action: a deterministic 1:1 mapping from the
 * entry kind onto the closed AUDIT_ACTIONS vocabulary — no invented actions.
 */
function auditActionForKind(kind: LedgerEntryKind): AuditAction {
  switch (kind) {
    case "deposit":
      return "deposit.confirmed";
    case "bid_fee":
      return "bid.accepted";
    case "settlement":
      return "settlement.completed";
    case "refund":
      return "refund.credited";
    case "withdrawal":
      return "withdrawal.transitioned";
  }
}

/**
 * Post one balanced journal entry inside the caller's transaction.
 *
 * Atomic failure: every refusal happens BEFORE any insert, so rejected or
 * conflicting calls produce zero economic effect; a thrown error aborts the
 * surrounding transaction (Convex OCC removes partial writes), keeping the
 * journal exactly-once and append-only.
 */
export async function postLedgerTransaction(
  ctx: LedgerCtx,
  input: PostLedgerTransactionInput,
): Promise<PostLedgerTransactionResult> {
  const db = ctx.db as LedgerDb;

  // 1. Pure evaluation — refuse invalid/unbalanced drafts before any write.
  const evaluated = evaluateLedgerEntry(input);
  if (!evaluated.ok) return { ok: false, status: "rejected", reason: evaluated.reason };

  // 2. Idempotency (Phase B foundation): user-bound key, request fingerprint.
  const key = deriveIdempotencyKey({
    op: input.idempotencyOp,
    userId: input.ownerUserId,
    clientToken: input.idempotencyToken,
  });
  const fingerprint = fingerprintRequest({
    kind: input.kind,
    refType: input.refType,
    refId: input.refId,
    postings: input.postings,
  });

  const registry = await checkIdempotencyKey(ctx, { key, fingerprint });
  if (registry.status === "conflict") {
    return { ok: false, status: "conflict", reason: "idempotency_conflict" };
  }
  if (registry.status === "replay") {
    // Exact replay: return the original outcome verbatim; ZERO writes here.
    return {
      ok: true,
      status: "replay",
      outcome: registry.outcome,
      // The registry record was committed by this primitive with
      // refType "ledgerEntries", so refId is the original entry id.
      entryId:
        registry.refType === "ledgerEntries" ? (registry.refId as Id<"ledgerEntries">) : null,
    };
  }

  // 3. Append-only inserts — one entry + N postings; no updates, no deletes.
  const now = Date.now();
  const entryId = (await db.insert("ledgerEntries", {
    kind: input.kind,
    refType: input.refType,
    refId: input.refId,
    idempotencyKey: key,
    createdAt: now,
  })) as Id<"ledgerEntries">;

  for (const posting of input.postings) {
    await db.insert("ledgerPostings", {
      entryId,
      account: posting.account,
      userSide: posting.userSide ?? undefined,
      direction: posting.direction,
      amountSantim: posting.amountSantim,
      provenanceLotIds:
        posting.provenanceLotIds !== undefined && posting.provenanceLotIds.length > 0
          ? posting.provenanceLotIds
          : undefined,
      createdAt: now,
    });
  }

  const outcome = JSON.stringify({ entryId });

  // 4. Idempotency commit + audit — same transaction as the effect; any
  //    failure here aborts the inserts above as well.
  await commitIdempotencyKey(ctx, {
    key,
    op: input.idempotencyOp,
    userId: input.ownerUserId,
    fingerprint,
    refType: "ledgerEntries",
    refId: entryId,
    outcome,
  });

  await recordAuditEvent(ctx, {
    actorId: input.ownerUserId,
    actorRole: input.ownerUserId === null ? "system" : "user",
    action: auditActionForKind(input.kind),
    entityType: "ledgerEntries",
    entityId: entryId,
    idempotencyKey: key,
    amountSantim: undefined,
    meta: {
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      postingCount: input.postings.length,
    },
  });

  return { ok: true, status: "posted", entryId, outcome };
}
