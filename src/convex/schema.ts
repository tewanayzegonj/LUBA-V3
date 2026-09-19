import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  abuseSubject,
  actorRole,
  auctionResult,
  auctionStatus,
  bidStatus,
  confirmationSource,
  fulfillmentMethod,
  fulfillmentStatus,
  idempotencyOp,
  language,
  ledgerEntryKind,
  ledgerRefType,
  lotStatus,
  notificationChannel,
  notificationEvent,
  notificationStatus,
  paymentProvider,
  paymentStatus,
  postingDirection,
  refundStatus,
  rejectionReason,
  reservationResolution,
  reservationStatus,
  settlementStatus,
  withdrawalStatus,
} from "./domain/contracts";

/* ────────────────────────────────────────────────────────────────────────────
 * LUBA V1 — Convex schema
 *
 * Implements docs/luba-v1-backend-schema.md (v1.0) exactly. Tagging follows
 * that document: FROZEN = dictated by PRD/TRD; IMPL = implementation detail;
 * OPEN = undecided upstream — admitted ONLY as optional config fields that
 * stay unset. No default business values are invented anywhere.
 *
 * Cross-cutting (§0):
 *  - Money: integer ETB santims everywhere; no float fields in money paths.
 *  - Time: UTC epoch millis.
 *  - Every status is a closed union (src/convex/domain/contracts.ts); unknown
 *    values cannot be stored (schemaValidation: true).
 *  - Append-only: ledgerEntries, ledgerPostings, auditEvents, and
 *    bidRefunds/notifications are never updated after creation except their
 *    own designated status fields; no deletes.
 *  - Blind bidding (§9/§18.4) holds by construction: no field or table in the
 *    bid path stores distribution, uniqueness, duplication, ranking, or a
 *    live lowest-unique value — there is nothing for a query to leak.
 * ──────────────────────────────────────────────────────────────────────────── */

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // The users table is the default users table brought in by authTables.
    // Convex Auth inserts rows internally, so LUBA identity fields are
    // optional validators here; defaults are applied at registration (Phase C)
    // and reads fail closed on `phoneVerified === true`.
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // optional contact info, NOT an auth method (PRD frozen). do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      // Two privilege classes: regular users can never perform operator
      // actions. Exact naming/hierarchy is OPEN (TRD §5) — a single role
      // field admits refinement without migration.
      role: v.optional(v.union(v.literal("user"), v.literal("operator"))),

      // ── LUBA identity fields (Backend Schema §2) ──
      phone: v.optional(v.string()), // E.164; unique where present (one identity per verified phone)
      phoneVerified: v.optional(v.boolean()), // FROZEN gate for all financial ops; default false at registration
      displayName: v.optional(v.string()),
      publicDisplayName: v.optional(v.string()), // nullable; published only with consent
      publicWinnerConsent: v.optional(v.boolean()), // FROZEN default false; winning never implies consent
      preferredLanguage: v.optional(language), // default "en" at registration
    })
      .index("email", ["email"]) // index for the email. do not remove or modify
      .index("by_phone", ["phone"]) // uniqueness enforced transactionally (partial-index semantics via lookup guard)
      .index("by_role", ["role"]),

    /* ── §3 wallets — projection only; NEVER the source of truth (TRD §6) ── */
    wallets: defineTable({
      userId: v.id("users"),
      availableSantim: v.number(), // integer ETB santims, >= 0
      updatedAt: v.number(), // server tx time
    }).index("by_user", ["userId"]), // 1:1 with users; uniqueness enforced transactionally

    /* ── §4.1 ledgerEntries — append-only financial truth (TRD §6) ── */
    ledgerEntries: defineTable({
      kind: ledgerEntryKind, // deposit | bid_fee | settlement | refund | withdrawal
      refType: ledgerRefType,
      refId: v.string(), // typed Id<...> at the mutation layer (index-safe polymorphic ref)
      idempotencyKey: v.string(), // unique; replay is a no-op returning the original outcome
      createdAt: v.number(),
    })
      .index("by_idempotencyKey", ["idempotencyKey"]) // FROZEN uniqueness discipline (§13)
      .index("by_ref", ["refType", "refId"])
      .index("by_kind_created", ["kind", "createdAt"]),

    /* ── §4.2 ledgerPostings — >= 2 per entry; debits == credits ──
       createdAt: required by §4.2's own by_account_created index spec (the
       doc's field table omits it; append-only posting write time per §0). */
    ledgerPostings: defineTable({
      entryId: v.id("ledgerEntries"),
      account: v.string(), // chart of accounts (contracts.ts PLATFORM_ACCOUNTS / wallet:{userId} / provider:*)
      userSide: v.optional(v.id("users")), // set when account is a user wallet account
      direction: postingDirection,
      amountSantim: v.number(), // > 0, integer
      provenanceLotIds: v.optional(v.array(v.id("provenanceLots"))), // FROZEN funding-provenance carrier
      createdAt: v.number(), // server tx time; equals the entry's createdAt
    })
      .index("by_entry", ["entryId"])
      .index("by_account_created", ["account", "createdAt"]) // reconciliation: per-account sums
      .index("by_userSide", ["userSide"]),

    /* ── §4.4 provenanceLots — funding provenance (TRD §6) ──
       Deposits create lots; debits consume lots; every refund re-credits the
       lots that originally funded the refunded bid. Lot-selection ordering is
       IMPL, owned by the financial layer. */
    provenanceLots: defineTable({
      userId: v.id("users"),
      paymentEventId: v.id("paymentEvents"),
      originalSantim: v.number(), // integer
      remainingSantim: v.number(), // decremented by debits; >= 0
      status: lotStatus, // open | exhausted
      createdAt: v.number(),
    })
      .index("by_user_status_remaining", ["userId", "status", "remainingSantim"]) // lot selection
      .index("by_user", ["userId"]),

    /* ── §5.1 paymentEvents — deposit intents / provider events ──
       providerRef uniqueness is FROZEN: a provider reference can journal
       money exactly once; replayed confirmations credit nothing (TRD §7). */
    paymentEvents: defineTable({
      userId: v.id("users"),
      provider: paymentProvider, // chapa | linkset (frozen provider set)
      providerRef: v.optional(v.string()), // unique where present
      amountSantim: v.number(), // > 0, integer; server-derived, never client-claimed
      status: paymentStatus, // initiated | pending_confirmation | confirmed | failed
      initiatedAt: v.number(),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_user_status", ["userId", "status"])
      .index("by_providerRef", ["providerRef"]), // uniqueness enforced transactionally (filtered where present)

    /* ── §5.2 paymentConfirmations — verified server-to-server only ──
       A confirmed paymentEvent + verified confirmation is the ONLY trigger
       for the deposit journal entry (wallet credit + lot creation + clearing
       postings), all in one atomic transaction. Client-claimed success is
       never trusted. */
    paymentConfirmations: defineTable({
      paymentEventId: v.id("paymentEvents"),
      source: confirmationSource, // webhook | hosted_return | receipt_verification (links.et scope OPEN)
      idempotencyKey: v.string(), // unique (§13)
      verified: v.boolean(), // true only after server-to-server verification
      createdAt: v.number(),
    }).index("by_idempotencyKey", ["idempotencyKey"]),

    /* ── §6 withdrawalRequests — record only; ALL parameters OPEN ──
       No payout mechanism is locked. Debit-on-request/approval/hold is IMPL,
       decided when PRD withdrawal parameters freeze. */
    withdrawalRequests: defineTable({
      userId: v.id("users"),
      amountSantim: v.number(), // > 0, integer
      status: withdrawalStatus, // requested | in_flight | completed | failed | cancelled
      providerRef: v.optional(v.string()), // payout reference, unique where present
      feeSantim: v.optional(v.number()), // OPEN — omitted until frozen
      requestedAt: v.number(),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_user_status", ["userId", "status"])
      .index("by_providerRef", ["providerRef"]),

    /* ── §7.1 prizes — operator-managed inventory lines ── */
    prizes: defineTable({
      title: v.string(),
      description: v.optional(v.string()),
      images: v.array(v.string()), // storage refs
      fulfillmentMethod: fulfillmentMethod, // delivery | pickup; per-auction override on auctions
      deliveryCoverage: v.optional(v.string()), // OPEN — operator-configured
      pickupLocationRef: v.optional(v.string()), // OPEN — modeled generically
      availableCount: v.number(), // >= 0; decremented by guarded reservation
      createdAt: v.number(),
    }).index("by_created", ["createdAt"]),

    /* ── §7.2 inventoryReservations — RESERVE → COMMIT | RELEASE (FROZEN) ──
       RESERVE: conditional decrement of prizes.availableCount guarded by
       availableCount >= quantity, in one transaction with the audit event; an
       auction cannot reach SCHEDULED/OPEN without a `reserved` reservation.
       COMMIT: only from `reserved`, only in the settlement transaction.
       RELEASE: only from `reserved` (void / terminal NO_WINNER /
       cancel-before-open); restores availableCount atomically. Concurrent
       auctions therefore cannot promise the same physical inventory. */
    inventoryReservations: defineTable({
      prizeId: v.id("prizes"),
      auctionId: v.id("auctions"),
      quantity: v.number(), // >= 1 (1 for V1 dedicated-line default)
      status: reservationStatus, // reserved | committed | released | cancelled
      reservedAt: v.number(),
      resolvedAt: v.optional(v.number()),
      resolvedBy: v.optional(reservationResolution), // settlement | void | no_winner | cancel_before_open
    })
      .index("by_auction", ["auctionId"]) // one active reservation per auction (unique lookup + guard)
      .index("by_prize_status", ["prizeId", "status"]),

    /* ── §8 auctions — exact TRD lifecycle: DRAFT → SCHEDULED → OPEN →
       CLOSED → SETTLED. No CLOSING state exists. CLOSED = bidding ended +
       result determined; with WINNER it holds settlement pending (inventory
       stays `reserved`) until settle success → SETTLED(WINNER) or deadline
       lapse → SETTLED(NO_WINNER). Settled exactly once, one final result. ── */
    auctions: defineTable({
      code: v.string(), // unique public auction code (mono display)
      title: v.string(),
      description: v.optional(v.string()),
      prizeId: v.id("prizes"),
      createdBy: v.id("users"), // operator
      status: auctionStatus, // DRAFT | SCHEDULED | OPEN | CLOSED | SETTLED — closed union
      startAt: v.optional(v.number()), // set when scheduled
      closeAt: v.number(), // authoritative close time (server-adjusted by anti-snipe)
      resultDeterminedAt: v.optional(v.number()), // set at finalization (OPEN→CLOSED)
      settlementDeadline: v.optional(v.number()), // set only when result = WINNER; duration OPEN
      feeSantim: v.optional(v.number()), // OPEN — fee model value; omitted until decided
      minBidSantim: v.optional(v.number()), // OPEN bounds; validation logic FROZEN
      maxBidSantim: v.optional(v.number()), // OPEN bounds; validation logic FROZEN
      antiSnipeWindowMs: v.optional(v.number()), // OPEN — unset while undecided
      antiSnipeExtendMs: v.optional(v.number()), // OPEN
      antiSnipeMaxExtensions: v.optional(v.number()), // OPEN
      extensionCount: v.number(), // tracked at runtime; default 0 at creation
      fulfillmentMethod: fulfillmentMethod,
      pickupDetails: v.optional(v.string()), // when pickup
      blindMode: v.boolean(), // always true in V1; structural marker of the blind rule
    })
      .index("by_status_closeAt", ["status", "closeAt"]) // sweeps: OPEN→CLOSED, SCHEDULED→OPEN
      .index("by_status_deadline", ["status", "settlementDeadline"]) // settlement-deadline void sweep
      .index("by_code", ["code"]) // uniqueness enforced transactionally
      .index("by_prize", ["prizeId"]),

    /* ── §9 bids — blind by construction ──
       No aggregate/counter/distribution table exists in the bid path; no
       field here or on auctions stores uniqueness/duplication/ranking/
       live-lowest data. Winner determination is computed at finalization by a
       pure function over by_auction_amount — never incrementally, never
       exposed live. There is nothing for a live query to leak. */
    bids: defineTable({
      auctionId: v.id("auctions"),
      bidderId: v.id("users"),
      amountSantim: v.number(), // integer santims
      feeSantim: v.number(), // server-computed at acceptance from frozen fee config; value OPEN
      status: bidStatus, // ACCEPTED | REJECTED (REJECTED rows are audit/status only, no economic effect)
      rejectionReason: v.optional(rejectionReason), // closed union; shown as reason class only
      refundStatus: refundStatus, // not_refundable | refunded | pending_refund
      placedAt: v.number(), // server tx time
      idempotencyKey: v.string(), // unique (§13)
    })
      .index("by_auction_amount", ["auctionId", "amountSantim"]) // winner determination + duplicate-amount rule
      .index("by_bidder_auction", ["bidderId", "auctionId"]) // own-bids projections
      .index("by_idempotencyKey", ["idempotencyKey"]) // FROZEN exactly-once discipline
      .index("by_auction_status", ["auctionId", "status"]),

    /* ── §10 auctionResults — exactly one per auction, after finalization ──
       Written in the finalization transaction; re-execution is idempotent by
       state guard. winner fields are set iff result = WINNER. */
    auctionResults: defineTable({
      auctionId: v.id("auctions"),
      result: auctionResult, // WINNER | NO_WINNER
      winningBidId: v.optional(v.id("bids")), // set iff WINNER
      winningAmountSantim: v.optional(v.number()), // set iff WINNER, integer
      finalAcceptedBidCount: v.number(), // the one published statistic
      closeTime: v.number(), // authoritative
      determinedAt: v.number(),
    }).index("by_auction", ["auctionId"]), // exactly one result per auction (unique lookup + guard)

    /* ── §11.1 settlementRecords — settlement-pending lives inside CLOSED ──
       pending = CLOSED-with-WINNER window; paid ⇒ SETTLED(WINNER); voided ⇒
       SETTLED(NO_WINNER) with refunds. Settlement debits use a distinct
       ledger class (kind: "settlement"). Deadline lapse = deterministic void.
       No external settlement payment path exists. */
    settlementRecords: defineTable({
      auctionId: v.id("auctions"),
      winnerId: v.id("users"),
      amountSantim: v.number(), // winning amount, integer santims
      status: settlementStatus, // pending | paid | voided
      deadline: v.number(), // duration OPEN
      paidAt: v.optional(v.number()),
      voidedAt: v.optional(v.number()),
      idempotencyKey: v.string(), // unique (§13)
    })
      .index("by_auction", ["auctionId"]) // one per auction (unique lookup + guard)
      .index("by_status_deadline", ["status", "deadline"]), // void sweep

    /* ── §11.2 bidRefunds — refund engine ledger-of-record ──
       Shared by NO_WINNER-at-close and deadline void. Refund destination is
       the LUBA wallet; provenance lots tagged; per-bid uniqueness makes
       duplicate credits structurally impossible; WINNER settlements refund
       nothing. */
    bidRefunds: defineTable({
      bidId: v.id("bids"), // unique — a bid is refunded exactly once
      auctionId: v.id("auctions"),
      bidderId: v.id("users"),
      feeSantim: v.number(), // exact refund amount
      provenanceLotIds: v.array(v.id("provenanceLots")), // FROZEN: original funding lots re-credited
      ledgerEntryId: v.id("ledgerEntries"),
      refundedAt: v.number(),
      idempotencyKey: v.string(), // unique (§13)
    })
      .index("by_bid", ["bidId"]) // FROZEN: refunded exactly once
      .index("by_auction", ["auctionId"])
      .index("by_idempotencyKey", ["idempotencyKey"]),

    /* ── §12 fulfillmentRecords — starts only after settlement; physical
       prizes only; no digital delivery, no prize-to-wallet credit ── */
    fulfillmentRecords: defineTable({
      auctionId: v.id("auctions"),
      winnerId: v.id("users"),
      method: fulfillmentMethod,
      status: fulfillmentStatus, // PENDING | ADDRESS_SUBMITTED | INSTRUCTIONS_SENT | IN_PROGRESS | COMPLETED | FAILED | UNRESOLVED
      deliveryAddress: v.optional(
        v.object({
          name: v.string(),
          phone: v.string(),
          region: v.string(),
          city: v.string(),
          subCity: v.string(),
          woreda: v.string(),
          landmark: v.optional(v.string()),
        }),
      ), // sensitive — owner + privileged operators only; never in audit records
      pickupDetails: v.optional(v.string()), // operator-configured; specifics OPEN
      verificationCodeRef: v.optional(v.string()), // proof reference; artifact format OPEN
      completedAt: v.optional(v.number()),
    })
      .index("by_auction", ["auctionId"]) // one per auction (unique lookup + guard)
      .index("by_status", ["status"]) // exception queues
      .index("by_winner", ["winnerId"]),

    /* ── §13 idempotencyRecords — general registry backing the unique-index
       discipline; each economic table also carries its own key + unique
       index. Replay of a stored key returns the original outcome and
       performs zero economic effect. ── */
    idempotencyRecords: defineTable({
      key: v.string(), // unique
      op: idempotencyOp, // bid | deposit_confirm | settlement | refund | withdrawal | notification_send
      refType: v.string(), // outcome entity table name
      refId: v.string(), // outcome entity id (index-safe polymorphic ref)
      outcome: v.optional(v.string()), // original result for replay no-ops
      createdAt: v.number(),
    })
      .index("by_key", ["key"]) // FROZEN uniqueness
      .index("by_op_ref", ["op", "refType", "refId"]),

    /* ── §14 auditEvents — append-only; one row per economic/lifecycle/
       privileged op written in the same transaction as the effect. Operator-
       readable, never user-exposed. No secrets, no OTP codes, no full
       addresses in meta (PII minimization). ── */
    auditEvents: defineTable({
      actorId: v.optional(v.id("users")), // null for system/sweeps
      actorRole: actorRole, // user | operator | system
      action: v.string(), // closed vocabulary of economic/lifecycle/inventory/anti-snipe/notification actions
      entityType: v.string(),
      entityId: v.string(), // index-safe polymorphic ref
      idempotencyKey: v.optional(v.string()), // correlation
      amountSantim: v.optional(v.number()), // integer when financial
      meta: v.optional(v.any()), // operator-correlation only; PII-minimized by mutation-layer policy
      createdAt: v.number(),
    })
      .index("by_entity", ["entityType", "entityId"])
      .index("by_actor_created", ["actorId", "createdAt"])
      .index("by_action_created", ["action", "createdAt"]),

    /* ── §15 notifications — frozen channel set: in-app + SMS only (no
       email). dedupeKey is the unique (event, recipient, channel) composite:
       duplicates structurally impossible. Retries mutate only `status`. ── */
    notifications: defineTable({
      recipientId: v.id("users"),
      event: notificationEvent, // closed union of frozen critical events
      channel: notificationChannel, // in_app | sms
      status: notificationStatus, // PENDING | SENT | FAILED
      dedupeKey: v.string(), // unique (event, recipient, channel) composite
      bodyKey: v.string(), // i18n key (EN/AM rendered at display)
      relatedEntityType: v.optional(v.string()),
      relatedEntityId: v.optional(v.string()), // deep-link target
      createdAt: v.number(),
      sentAt: v.optional(v.number()),
    })
      .index("by_dedupeKey", ["dedupeKey"]) // FROZEN idempotency
      .index("by_recipient_created", ["recipientId", "createdAt"])
      .index("by_status", ["status"]),

    /* ── §16 abuseCounters — generic anti-abuse throttling ONLY, never a
       bid-count cap (existence/value of any cap remains OPEN). Thresholds
       are IMPL configuration. ── */
    abuseCounters: defineTable({
      subject: abuseSubject, // otp_request | otp_verify | bid_submit | deposit_init | withdrawal_req
      subjectId: v.string(), // phone hash or user id
      windowStart: v.number(),
      count: v.number(),
    }).index("by_subject_window", ["subject", "subjectId", "windowStart"]),
  },
  {
    // Backend Schema §0 FROZEN mandate: every status is a closed union and
    // unknown values cannot be stored. (Template shipped with validation
    // off; the approved schema requires it on.)
    schemaValidation: true,
  },
);

export default schema;

export type LubaUserRole = "user" | "operator"; // matches users.role; exact naming/hierarchy OPEN (TRD §5)
