import { v } from "convex/values";

/**
 * LUBA V1 domain contracts — closed status unions (Backend Schema §0).
 *
 * Every status in the system is one of these closed unions: unknown values
 * are rejected by schema validation. These are the ONLY statuses; no state
 * lives outside them. Money fields across the schema are integer ETB
 * santims (no floats anywhere in money paths).
 *
 * OPEN decisions are NOT defaulted here: fee, bounds, anti-snipe, deadline,
 * withdrawal, KYC parameters are optional schema fields that remain unset.
 */

/* ── Auction lifecycle — FROZEN (TRD §9): DRAFT → SCHEDULED → OPEN → CLOSED → SETTLED.
   No CLOSING state exists. Settlement-pending is modeled inside CLOSED via
   settlementRecords.status = "pending". ── */
export const AUCTION_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "OPEN",
  "CLOSED",
  "SETTLED",
] as const;
export type AuctionStatus = (typeof AUCTION_STATUSES)[number];
export const auctionStatus = v.union(
  ...AUCTION_STATUSES.map((s) => v.literal(s)),
);

/* ── Ledger (financial truth) ── */
export const LEDGER_ENTRY_KINDS = [
  "deposit",
  "bid_fee",
  "settlement",
  "refund",
  "withdrawal",
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];
export const ledgerEntryKind = v.union(
  ...LEDGER_ENTRY_KINDS.map((s) => v.literal(s)),
);

export const LEDGER_REF_TYPES = [
  "bid",
  "auction",
  "paymentEvent",
  "withdrawalRequest",
  "user",
  "fulfillmentRecord",
] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];
export const ledgerRefType = v.union(
  ...LEDGER_REF_TYPES.map((s) => v.literal(s)),
);

export const POSTING_DIRECTIONS = ["debit", "credit"] as const;
export type PostingDirection = (typeof POSTING_DIRECTIONS)[number];
export const postingDirection = v.union(
  ...POSTING_DIRECTIONS.map((s) => v.literal(s)),
);

export const LOT_STATUSES = ["open", "exhausted"] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];
export const lotStatus = v.union(...LOT_STATUSES.map((s) => v.literal(s)));

/* ── Chart of accounts (Backend Schema §4.3) — small and fixed.
   Settlement is a distinct ledger class from bid fees (frozen); refunds
   never silently change account/ledger class (provenance preserved). ── */
export const PLATFORM_ACCOUNTS = {
  bidFeeRevenue: "platform:bid_fee_revenue",
  settlementRevenue: "platform:settlement_revenue",
  depositClearing: "platform:deposit_clearing",
  withdrawalClearing: "platform:withdrawal_clearing",
} as const;
export const walletAccount = (userId: string) => `wallet:${userId}`;
export const providerAccount = (provider: string) =>
  `provider:${provider}:settlement`;

/* ── Payments ── */
export const PAYMENT_PROVIDERS = ["chapa", "linkset"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const paymentProvider = v.union(
  ...PAYMENT_PROVIDERS.map((s) => v.literal(s)),
);

export const PAYMENT_STATUSES = [
  "initiated",
  "pending_confirmation",
  "confirmed",
  "failed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatus = v.union(
  ...PAYMENT_STATUSES.map((s) => v.literal(s)),
);

export const CONFIRMATION_SOURCES = [
  "webhook",
  "hosted_return",
  "receipt_verification",
] as const;
export type ConfirmationSource = (typeof CONFIRMATION_SOURCES)[number];

/* V1 payment purpose: paymentEvents are DEPOSIT intents (Backend Schema §5.1).
   Withdrawal payouts are separate withdrawalRequests records (§6) — no
   paymentEvents purpose beyond deposit exists in V1. */
export const PAYMENT_PURPOSES = ["deposit"] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/* Ingested provider-event verification lifecycle (adapter boundary, IMPL —
   not a schema field): "unverified" at ingestion; "verified" only after
   server-to-server verification (maps to paymentConfirmations.verified=true);
   "rejected" when verification fails. Provider payloads are untrusted input
   until an adapter reports verified=true. */
export const PROVIDER_EVENT_VERIFICATION = [
  "unverified",
  "verified",
  "rejected",
] as const;
export type EventVerificationStatus =
  (typeof PROVIDER_EVENT_VERIFICATION)[number];
export const confirmationSource = v.union(
  ...CONFIRMATION_SOURCES.map((s) => v.literal(s)),
);

/* ── Withdrawals — record only; all parameters OPEN ── */
export const WITHDRAWAL_STATUSES = [
  "requested",
  "in_flight",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];
export const withdrawalStatus = v.union(
  ...WITHDRAWAL_STATUSES.map((s) => v.literal(s)),
);

/* ── Prizes / inventory — RESERVE → COMMIT | RELEASE (frozen model) ── */
export const FULFILLMENT_METHODS = ["delivery", "pickup"] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];
export const fulfillmentMethod = v.union(
  ...FULFILLMENT_METHODS.map((s) => v.literal(s)),
);

export const RESERVATION_STATUSES = [
  "reserved",
  "committed",
  "released",
  "cancelled",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const reservationStatus = v.union(
  ...RESERVATION_STATUSES.map((s) => v.literal(s)),
);

export const RESERVATION_RESOLUTIONS = [
  "settlement",
  "void",
  "no_winner",
  "cancel_before_open",
] as const;
export type ReservationResolution = (typeof RESERVATION_RESOLUTIONS)[number];
export const reservationResolution = v.union(
  ...RESERVATION_RESOLUTIONS.map((s) => v.literal(s)),
);

/* ── Bids — blind by construction (Backend Schema §9): no uniqueness,
   duplication, ranking, or live-lowest field exists anywhere. ── */
export const BID_STATUSES = ["ACCEPTED", "REJECTED"] as const;
export type BidStatus = (typeof BID_STATUSES)[number];
export const bidStatus = v.union(...BID_STATUSES.map((s) => v.literal(s)));

export const REJECTION_REASONS = [
  "insufficient_funds",
  "too_late",
  "out_of_range",
  "duplicate_amount",
  "rate_limited",
  "not_open",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];
export const rejectionReason = v.union(
  ...REJECTION_REASONS.map((s) => v.literal(s)),
);

export const REFUND_STATUSES = [
  "not_refundable",
  "refunded",
  "pending_refund",
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const refundStatus = v.union(
  ...REFUND_STATUSES.map((s) => v.literal(s)),
);

/* ── Results & settlement ── */
export const AUCTION_RESULTS = ["WINNER", "NO_WINNER"] as const;
export type AuctionResult = (typeof AUCTION_RESULTS)[number];
export const auctionResult = v.union(
  ...AUCTION_RESULTS.map((s) => v.literal(s)),
);

/* "pending" = CLOSED-with-WINNER settlement window; "paid" ⇒ SETTLED(WINNER);
   "voided" ⇒ SETTLED(NO_WINNER) with refunds. */
export const SETTLEMENT_STATUSES = ["pending", "paid", "voided"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const settlementStatus = v.union(
  ...SETTLEMENT_STATUSES.map((s) => v.literal(s)),
);

/* ── Fulfillment — minimal TRD §14 vocabulary ── */
export const FULFILLMENT_STATUSES = [
  "PENDING",
  "ADDRESS_SUBMITTED",
  "INSTRUCTIONS_SENT",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "UNRESOLVED",
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];
export const fulfillmentStatus = v.union(
  ...FULFILLMENT_STATUSES.map((s) => v.literal(s)),
);

/* ── Idempotency registry ── */
export const IDEMPOTENCY_OPS = [
  "bid",
  "deposit_confirm",
  "settlement",
  "refund",
  "withdrawal",
  "notification_send",
] as const;
export type IdempotencyOp = (typeof IDEMPOTENCY_OPS)[number];
export const idempotencyOp = v.union(
  ...IDEMPOTENCY_OPS.map((s) => v.literal(s)),
);

/* ── Settlement campaigns (Phase I, frozen plan §5) — resumable winner
   determination / per-bid refund work over post-close immutable sets. ── */
export const CAMPAIGN_KINDS = ["winner_determination", "bid_refunds"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];
export const campaignKind = v.union(...CAMPAIGN_KINDS.map((s) => v.literal(s)));

export const CAMPAIGN_TRIGGERS = ["no_winner", "settlement_void"] as const;
export type CampaignTrigger = (typeof CAMPAIGN_TRIGGERS)[number];
export const campaignTrigger = v.union(...CAMPAIGN_TRIGGERS.map((s) => v.literal(s)));

export const CAMPAIGN_STATUSES = ["in_progress", "complete"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const campaignStatus = v.union(...CAMPAIGN_STATUSES.map((s) => v.literal(s)));

/* ── Audit ── */
export const ACTOR_ROLES = ["user", "operator", "system"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];
export const actorRole = v.union(...ACTOR_ROLES.map((s) => v.literal(s)));

/**
 * Closed audit action vocabulary (Backend Schema §14: actions span economic
 * ops, lifecycle transitions, RESERVE/COMMIT/RELEASE, anti-snipe extension,
 * notification send, operator actions). Extending this list is the only way
 * a new audited action class can appear — keeps `auditEvents.action` a closed
 * union in spirit while remaining a documented string in the schema.
 */
export const AUDIT_ACTIONS = [
  // Economic operations (TRD §20)
  "bid.accepted",
  "bid.rejected",
  "deposit.confirmed",
  "settlement.completed",
  "settlement.voided",
  "refund.credited",
  "withdrawal.transitioned",
  // Lifecycle transitions (TRD §9)
  "auction.scheduled",
  "auction.opened",
  "auction.closed",
  "auction.settled",
  "auction.cancelled",
  // Inventory (TRD §12)
  "inventory.reserved",
  "inventory.committed",
  "inventory.released",
  // Anti-snipe (TRD §18)
  "auction.antisnipe_extended",
  // Notifications (TRD §15)
  "notification.sent",
  // Privileged/operator actions (TRD §20)
  "operator.action",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const isAuditAction = (value: string): value is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(value);

/* ── Notifications — frozen channel set: in-app + SMS only (no email) ── */
export const NOTIFICATION_EVENTS = [
  "AUCTION_RESULT",
  "WINNER_NOTIFICATION",
  "SETTLEMENT_DEADLINE",
  "SETTLEMENT_REMINDER",
  "SETTLEMENT_FAILED",
  "REFUND_COMPLETED",
  "FULFILLMENT_UPDATE",
  "SYSTEM",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const notificationEvent = v.union(
  ...NOTIFICATION_EVENTS.map((s) => v.literal(s)),
);

export const NOTIFICATION_CHANNELS = ["in_app", "sms"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const notificationChannel = v.union(
  ...NOTIFICATION_CHANNELS.map((s) => v.literal(s)),
);

export const NOTIFICATION_STATUSES = ["PENDING", "SENT", "FAILED"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const notificationStatus = v.union(
  ...NOTIFICATION_STATUSES.map((s) => v.literal(s)),
);

/* ── Anti-abuse counters — generic throttling only, never a bid-count cap
   (existence/value of any cap remains OPEN) ── */
export const ABUSE_SUBJECTS = [
  "otp_request",
  "otp_verify",
  "bid_submit",
  "deposit_init",
  "withdrawal_req",
] as const;
export type AbuseSubject = (typeof ABUSE_SUBJECTS)[number];
export const abuseSubject = v.union(...ABUSE_SUBJECTS.map((s) => v.literal(s)));

/* ── User preferences ── */
export const LANGUAGES = ["en", "am"] as const;
export type Language = (typeof LANGUAGES)[number];
export const language = v.union(...LANGUAGES.map((s) => v.literal(s)));
