# LUBA — V1 Backend Schema

**Document status:** FINAL (v1.0). The V1 Convex data model and domain boundaries — a design artifact, not code.
**Basis (authoritative, in order):** Approved PRD · `docs/luba-v1-trd.md` (technical authority — the lifecycle, settlement, inventory, and projection contracts here implement TRD §6–§20) · `docs/luba-master-design-authority.md` (no schema impact) · `docs/luba-v1-ui-ux-design-brief.md` (status vocabulary) · `docs/luba-v1-app-flow.md` (flows this model must serve).
**Tagging:** **FROZEN** = dictated by PRD/TRD; **IMPL** = implementation detail within frozen constraints; **OPEN** = undecided upstream — the schema admits it via configuration fields, never a default.
**Explicitly out of scope:** Convex function code, mutations/queries, auth wiring, provider configuration. This document defines *what the database must make enforceable*.

---

## 0. Cross-Cutting Conventions

- **Money:** every monetary field is an **integer ETB santim** (`i64`-safe number, non-negative unless a signed ledger posting). No float fields exist anywhere in money paths. FROZEN.
- **Time:** all timestamps UTC epoch millis (`number`). FROZEN.
- **Identity:** all entity references are Convex document IDs typed `Id<"table">`. IMPL.
- **No enums as strings-in-the-wild:** every status is a closed union; unknown values cannot be stored (schema validation on). FROZEN.
- **Idempotency:** every economic operation references a unique idempotency key with a unique index; replay is a no-op returning the original outcome. FROZEN.
- **Append-only discipline:** ledger journal, audit log, and notification records are never updated after creation except their own designated status-retry fields; no deletes. FROZEN.
- **Audit logging:** every economic/lifecycle/privileged operation writes one `auditEvents` row in the same transaction. FROZEN.
- **Privacy:** every client-facing read goes through whitelisted projections (§15); prohibited fields are structurally absent. FROZEN.

---

## 1. Entity Map (relationship overview)

```
users ─┬─< wallets (1:1) >─── ledgerPostings (accountRef) >─── ledgerEntries
       ├─< provenanceLots            ▲                ▲
       ├─< bids >── auctions ────────┘ (posting refs bid/auction/settlement)
       │      └─< bidRefunds (per-bid refund record)
       ├─< paymentEvents (provider deposits) >── paymentConfirmations
       ├─< withdrawalRequests
       ├─< notifications
       └─< fulfillmentRecords ── auctions

prizes (inventory lines) ─< auctions (RESERVE) ─< inventoryReservations
                                             COMMIT/RELEASE mutate reservation status

auctions ── auctionResults (1:1, after finalization)
operators (users with privileged role) ─< auditEvents (actor)
```

---

## 2. `users`

The Convex Auth `users` table is extended with LUBA identity fields (auth tables themselves remain untouched). FROZEN basis: TRD §4.

| Field | Type | Req | Notes |
|---|---|---|
| (auth base fields) | — | — | existing `authTables` fields preserved |
| `phone` | `string` (E.164) | optional | unique where present; set at registration |
| `phoneVerified` | `boolean` | yes | default `false`; `true` only after OTP verification. FROZEN gate for all financial ops |
| `displayName` | `string` | optional | user-facing name |
| `publicDisplayName` | `string` | optional | nullable — published only with consent. FROZEN |
| `publicWinnerConsent` | `boolean` | yes | default **`false`**. Winning never implies consent. FROZEN |
| `email` | `string` | optional | optional contact info, **not** an auth method. FROZEN |
| `preferredLanguage` | `"en" \| "am"` | yes | default `"en"` |
| `role` | `"user" \| "operator"` | yes | default `"user"`. Two privilege classes; exact naming/hierarchy **OPEN** (TRD §5) — single `role` field admits refinement without migration |

**Indexes:** `by_phone` (unique on `phone`), `by_role`.
**Uniqueness:** `phone` unique (partial/filtered index where null). FROZEN (one identity per verified phone).
**Ownership:** a user reads only their own row via projections; operators read via privileged queries (audit-attributed). IMPL.

> **KYC depth `[OPEN]`:** additional verification fields are deliberately **not** modeled; when frozen, they extend this table without breaking the model.

---

## 3. `wallets` — projection only

One per user. **Never the source of truth** (TRD §6). FROZEN.

| Field | Type | Req | Notes |
|---|---|---|---|
| `userId` | `Id<"users">` | yes | unique |
| `availableSantim` | `number` | yes | ≥ 0; integer santims |
| `updatedAt` | `number` | yes | server tx time |

**Indexes:** `by_user` (unique).
**Invariant the schema must make enforceable:** `availableSantim` is updated **only in the same transaction** as the corresponding `ledgerEntries`/`ledgerPostings` writes; a reconciliation job (§14) compares projection vs ledger sums per user and flags mismatches as exceptions. FROZEN.

---

## 4. Ledger — `ledgerEntries` + `ledgerPostings` (financial truth)

Append-only. FROZEN.

### 4.1 `ledgerEntries`
| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` / doc | — | — | |
| `kind` | `"deposit" \| "bid_fee" \| "settlement" \| "refund" \| "withdrawal"` | yes | closed union |
| `refType` | `"bid" \| "auction" \| "paymentEvent" \| "withdrawalRequest" \| "user" \| "fulfillmentRecord"` | yes | what this entry is about |
| `refId` | `Id<…>` | yes | |
| `idempotencyKey` | `string` | yes | unique (§13) |
| `createdAt` | `number` | yes | server tx time |

**Indexes:** `by_idempotencyKey` (unique), `by_ref` (`refType, refId`), `by_kind_created`.

### 4.2 `ledgerPostings`
One entry has **≥ 2 postings**; debits == credits per entry and globally. FROZEN.

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `Id<"ledgerEntries">` | yes | |
| `account` | `string` | yes | chart of accounts (§4.3) |
| `userSide` | `Id<"users">` | optional | set when `account` is a user wallet account |
| `direction` | `"debit" \| "credit"` | yes | |
| `amountSantim` | `number` | yes | > 0, integer |
| `provenanceLotIds` | `Id<"provenanceLots">[]` | optional | **funding provenance** tag — set on wallet credits created by refunds (and tracked on debits for lot consumption). FROZEN invariant carrier |

**Indexes:** `by_entry`, `by_account_created` (reconciliation: per-account sums), `by_userSide`.
**Invariant:** every balanced journal entry is atomic with its wallet projection update and entity status update; unbalanced or partial states cannot exist. FROZEN.

### 4.3 Chart of accounts (small, fixed) — IMPL
`wallet:{userId}` · `platform:bid_fee_revenue` · `platform:settlement_revenue` · `platform:deposit_clearing` · `platform:withdrawal_clearing` · `provider:{provider}:settlement`. Settlement uses a **distinct ledger class from bid fees** (FROZEN via `kind`); refunds never silently change account/ledger class (provenance preserved).

### 4.4 `provenanceLots` — funding provenance
| Field | Type | Req | Notes |
|---|---|---|---|
| `userId` | `Id<"users">` | yes | |
| `paymentEventId` | `Id<"paymentEvents">` | yes | origin of the funds |
| `originalSantim` | `number` | yes | deposit amount |
| `remainingSantim` | `number` | yes | decremented by debits; ≥ 0 |
| `status` | `"open" \| "exhausted"` | yes | |
| `createdAt` | number | yes | |

**Indexes:** `by_user_status_remaining` (lot selection), `by_user`.
**FROZEN invariant:** deposits create lots; debits consume lots; **every refund credits the wallet tagged with the lot(s) that originally funded the refunded bid** — traceable end-to-end, never reclassified. Lot-selection ordering (e.g., FIFO) is IMPL, owned by the financial layer, satisfying only that invariant.

---

## 5. Payments — `paymentEvents` + `paymentConfirmations`

### 5.1 `paymentEvents` (deposit intents / provider events)
| Field | Type | Req | Notes |
|---|---|---|---|
| `userId` | `Id<"users">` | yes | |
| `provider` | `"chapa" \| "linkset"` | yes | union admits only frozen providers |
| `providerRef` | `string` | optional | provider transaction/reference id — **unique where present** |
| `amountSantim` | `number` | yes | > 0 |
| `status` | `"initiated" \| "pending_confirmation" \| "confirmed" \| "failed"` | yes | |
| `initiatedAt` / `resolvedAt` | `number` | optional/yes-when-resolved | |

**Indexes:** `by_user_status`, `by_providerRef` (unique, filtered). **Uniqueness FROZEN:** a provider reference can journal money **exactly once**; replayed confirmations credit nothing (TRD §7).

### 5.2 `paymentConfirmations`
| Field | Type | Req | Notes |
|---|---|---|---|
| `paymentEventId` | `Id<"paymentEvents">` | yes | |
| `source` | `"webhook" \| "hosted_return" \| "receipt_verification"` | yes | links.et scope **OPEN** — union admits only verified sources |
| `idempotencyKey` | `string` | yes | unique (§13) |
| `verified` | `boolean` | yes | true only after server-to-server verification |
| `createdAt` | number | yes | |

**Invariant:** a `confirmed` paymentEvent + verified confirmation is the **only** trigger for the deposit journal entry (wallet credit + provenance lot creation + clearing account postings) — all in one atomic transaction. Client-claimed success is never trusted. FROZEN.

---

## 6. `withdrawalRequests`

Policy-level V1; **all parameters OPEN** — the schema models the *record*, not the rules.

| Field | Type | Req | Notes |
|---|---|---|---|
| `userId` | Id | yes | |
| `amountSantim` | number | yes | > 0 |
| `status` | `"requested" \| "in_flight" \| "completed" \| "failed" \| "cancelled"` | yes | operator/ledger truth only |
| `providerRef` | string | optional | payout reference, unique where present |
| `feeSantim` | number | optional | **OPEN** — omitted until frozen |
| `requestedAt` / `resolvedAt` | number | yes / optional | |

**Indexes:** `by_user_status`, `by_providerRef` (unique filtered).
**Schema-enforceable invariants:** withdrawal appears in wallet history only from ledger truth (its journal entry); in-flight funds cannot double-spend (debit-on-request/approval/hold is IMPL, decided when PRD parameters freeze); payout confirmation journals through the same verification-before-journaling discipline as deposits. FROZEN disciplines, IMPL mechanism.

---

## 7. Prizes / Inventory — `prizes` + `inventoryReservations`

### 7.1 `prizes` (operator-managed inventory lines)
| Field | Type | Req | Notes |
|---|---|---|---|
| `title` | string | yes | |
| `description` | string | optional | |
| `images` | `string[]` | yes | storage refs |
| `fulfillmentMethod` | `"delivery" \| "pickup"` | yes | per-auction override allowed (below) |
| `deliveryCoverage` | string | optional | **OPEN** — operator-configured |
| `pickupLocationRef` | Id (operator config) | optional | **OPEN** — modeled generically |
| `availableCount` | number | yes | ≥ 0 |
| `createdAt` | number | yes | |

**Indexes:** `by_status_created` (needs `status`? keep minimal: `by_created`).

### 7.2 `inventoryReservations` — RESERVE → COMMIT / RELEASE (FROZEN model)
| Field | Type | Req | Notes |
|---|---|---|---|
| `prizeId` | `Id<"prizes">` | yes | |
| `auctionId` | `Id<"auctions">` | yes | unique among active reservations |
| `quantity` | number | yes | ≥ 1 (1 for V1 dedicated-line default) |
| `status` | `"reserved" \| "committed" \| "released" \| "cancelled"` | yes | RESERVE=`reserved`; COMMIT=`committed` at settlement; RELEASE=`released`/`cancelled` |
| `reservedAt` / `resolvedAt` | number | yes / optional | |
| `resolvedBy` | `"settlement" \| "void" \| "no_winner" \| "cancel_before_open"` | optional | audit-grade reason |

**Indexes:** `by_auction` (unique on `auctionId` — one active reservation per auction), `by_prize_status`.
**FROZEN invariants the schema makes enforceable:**
- **RESERVE:** conditional decrement of `prizes.availableCount` guarded by `availableCount >= quantity`, executed in one transaction that creates the reservation and the audit event; a losing concurrent attempt fails with insufficient availability. An auction **cannot reach SCHEDULED/OPEN without a `reserved` reservation** — the publish mutation checks it in-transaction.
- **COMMIT:** only from `reserved`, only in the settlement transaction (TRD §11 Phase 2a).
- **RELEASE:** only from `reserved`; on void / terminal NO_WINNER / cancel-before-open; restores `availableCount` atomically.
- Because RESERVE precedes any promise, concurrent auctions cannot promise the same physical inventory. Multi-auction quantity backing per line: **OPEN** (default dedicated line per auction).

---

## 8. `auctions`

| Field | Type | Req | Notes |
|---|---|---|---|
| `code` | string | yes | unique public auction code (mono display) |
| `title` | string | yes | |
| `description` | string | optional | |
| `prizeId` | `Id<"prizes">` | yes | |
| `createdBy` | `Id<"users">` | yes | operator |
| `status` | `"DRAFT" \| "SCHEDULED" \| "OPEN" \| "CLOSED" \| "SETTLED"` | yes | **exact TRD lifecycle. No CLOSING state exists** — FROZEN |
| `startAt` | number | optional | set when scheduled |
| `closeAt` | number | yes | authoritative close time (server-adjusted by anti-snipe) |
| `resultDeterminedAt` | number | optional | set at finalization (OPEN→CLOSED) |
| `settlementDeadline` | number | optional | set only when result = WINNER; duration **OPEN** |
| `feeSantim` | number | optional | **OPEN** — frozen fee model value; omitted until decided |
| `minBidSantim` / `maxBidSantim` | number | optional | **OPEN** bounds; logic FROZEN |
| `antiSnipeWindowMs` / `antiSnipeExtendMs` / `antiSnipeMaxExtensions` | number | optional | **OPEN** — config fields exist, unset while undecided; `extensionCount` tracked at runtime |
| `extensionCount` | number | yes | default 0 |
| `fulfillmentMethod` | `"delivery" \| "pickup"` | yes | |
| `pickupDetails` | string | optional | when pickup |
| `blindMode` | boolean | yes | always `true` in V1; structural marker of the blind rule |

**Indexes:** `by_status_closeAt` (sweeps: OPEN→CLOSED, SCHEDULED→OPEN), `by_status_deadline` (settlement-deadline sweep), `by_code` (unique), `by_prize`.
**Uniqueness:** `code` unique.

**Lifecycle contract (FROZEN, matches TRD §9/§11):** `DRAFT → SCHEDULED → OPEN → CLOSED → SETTLED`; transitions only via guarded mutations checking state in-transaction; queries never mutate. CLOSED = bidding ended + result determined; with WINNER it holds **settlement pending** (inventory stays `reserved`) until settle success (→ SETTLED(WINNER)) or deadline (→ SETTLED(NO_WINNER)). Settled exactly once, one final result.

---

## 9. `bids`

| Field | Type | Req | Notes |
|---|---|---|---|
| `auctionId` | Id | yes | |
| `bidderId` | Id | yes | |
| `amountSantim` | number | yes | integer |
| `feeSantim` | number | yes | server-computed at acceptance (from frozen fee config; **OPEN** value) |
| `status` | `"ACCEPTED" \| "REJECTED"` | yes | REJECTED rows are audit/status only (no economic effect) |
| `rejectionReason` | `"insufficient_funds" \| "too_late" \| "out_of_range" \| "duplicate_amount" \| "rate_limited" \| "not_open"` | optional | closed union; shown as reason class only |
| `refundStatus` | `"not_refundable" \| "refunded" \| "pending_refund"` | yes | default `not_refundable` |
| `placedAt` | number | yes | server tx time |
| `idempotencyKey` | string | yes | unique (§13) |

**Indexes:** `by_auction_amount` (winner determination + duplicate-amount rule), `by_bidder_auction`, `by_idempotencyKey` (unique), `by_auction_status`.
**Blind-bidding structural enforcement (FROZEN):** no aggregate/counter/distribution table exists in the bid path; no field on `bids` or `auctions` stores uniqueness/duplication/ranking/live-lowest data; winner determination is computed at finalization by the pure function over `by_auction_amount` — never incrementally, never exposed live. There is nothing for a live query to leak.
**Same-amount-repeat rule:** validator reads the frozen config flag (`duplicate_amount` rejection possible); rule existence/value **OPEN**.

---

## 10. `auctionResults` (1:1 with auctions, after finalization)

| Field | Type | Req | Notes |
|---|---|---|---|
| `auctionId` | Id | yes | unique |
| `result` | `"WINNER" \| "NO_WINNER"` | yes | |
| `winningBidId` | `Id<"bids">` | optional | set iff WINNER |
| `winningAmountSantim` | number | optional | set iff WINNER |
| `finalAcceptedBidCount` | number | yes | the one published statistic |
| `closeTime` | number | yes | authoritative |
| `determinedAt` | number | yes | |

**Indexes:** `by_auction` (unique). **Invariant:** exactly one result per auction, written in the finalization transaction; re-execution is idempotent by state guard. FROZEN.

---

## 11. Settlement — `settlementRecords` and refunds — `bidRefunds`

### 11.1 `settlementRecords`
| Field | Type | Req | Notes |
|---|---|---|---|
| `auctionId` | Id | yes | unique |
| `winnerId` | Id | yes | |
| `amountSantim` | number | yes | winning amount, integer santims |
| `status` | `"pending" \| "paid" \| "voided"` | yes | `pending` = CLOSED-with-WINNER window; `paid` ⇒ auction SETTLED(WINNER); `voided` ⇒ SETTLED(NO_WINNER) |
| `deadline` | number | yes | duration **OPEN** |
| `paidAt` / `voidedAt` | number | optional | |
| `idempotencyKey` | string | yes | unique (§13) |

**Indexes:** `by_auction` (unique), `by_status_deadline` (void sweep).
**FROZEN invariants:** settlement debits use a **distinct ledger class** from bid fees (`kind: "settlement"`); settle = one atomic transaction (wallet debit + COMMIT + status → SETTLED + audit); deadline lapse = deterministic void (RELEASE + refunds). No external settlement payment path exists.

### 11.2 `bidRefunds` (refund engine ledger-of-record, shared by NO_WINNER-at-close and deadline void)
| Field | Type | Req | Notes |
|---|---|---|---|
| `bidId` | Id | yes | **unique** — a bid is refunded exactly once |
| `auctionId` / `bidderId` | Id | yes | |
| `feeSantim` | number | yes | exact refund amount |
| `provenanceLotIds` | `Id<"provenanceLots">[]` | yes | **FROZEN:** original funding lots re-credited |
| `ledgerEntryId` | Id | yes | |
| `refundedAt` | number | yes | |
| `idempotencyKey` | string | yes | unique (§13) |

**Indexes:** `by_bid` (unique), `by_auction`, `by_idempotencyKey` (unique).
**FROZEN invariant:** refund destination is the **LUBA wallet**; provenance tagged; per-bid idempotency makes duplicate credits structurally impossible; auctions settled with WINNER refund nothing.

---

## 12. `fulfillmentRecords`

| Field | Type | Req | Notes |
|---|---|---|---|
| `auctionId` | Id | yes | unique |
| `winnerId` | Id | yes | |
| `method` | `"delivery" \| "pickup"` | yes | |
| `status` | `"PENDING" \| "ADDRESS_SUBMITTED" \| "INSTRUCTIONS_SENT" \| "IN_PROGRESS" \| "COMPLETED" \| "FAILED" \| "UNRESOLVED"` | yes | minimal TRD §14 vocabulary |
| `deliveryAddress` | object (name, phone, region, city, subCity, woreda, landmark) | optional | sensitive — owner + privileged operators only; never in audit records (§14 privacy) |
| `pickupDetails` | string | optional | operator-configured; **OPEN** specifics |
| `verificationCodeRef` | string | optional | pickup confirmation / proof reference; artifact format **OPEN** |
| `completedAt` | number | optional | |

**Indexes:** `by_auction` (unique), `by_status`, `by_winner`.
**FROZEN:** fulfillment starts only after settlement; physical prizes only; no digital delivery, no prize-to-wallet credit.

---

## 13. Idempotency Records — `idempotencyRecords`

One general registry backing the unique-index discipline (each economic table also carries its own key + unique index as above).

| Field | Type | Req | Notes |
|---|---|---|---|
| `key` | string | yes | **unique** |
| `op` | `"bid" \| "deposit_confirm" \| "settlement" \| "refund" \| "withdrawal" \| "notification_send"` | yes | |
| `refType` / `refId` | string / Id | yes | outcome entity |
| `outcome` | string | optional | original result for replay no-ops |
| `createdAt` | number | yes | |

**Indexes:** `by_key` (unique), `by_op_ref`.
**FROZEN invariant:** replay of a stored key returns the original outcome and performs **zero** economic effect.

---

## 14. `auditEvents` (append-only)

| Field | Type | Req | Notes |
|---|---|---|---|
| `actorId` | `Id<"users">` | optional | null for system/sweeps |
| `actorRole` | `"user" \| "operator" \| "system"` | yes | |
| `action` | string | yes | closed vocabulary: economic ops, lifecycle transitions, RESERVE/COMMIT/RELEASE, anti-snipe extension, notification send, operator actions |
| `entityType` / `entityId` | string / Id | yes | |
| `idempotencyKey` | string | optional | correlation |
| `amountSantim` | number | optional | integer when financial |
| `meta` | object | optional | **no secrets, no OTP codes, no full addresses** (PII minimization) |
| `createdAt` | number | yes | server tx time |

**Indexes:** `by_entity`, `by_actor_created`, `by_action_created`.
**FROZEN:** every economic op, lifecycle transition, inventory operation, anti-snipe extension, privileged action, and notification send writes one row **in the same transaction** as the effect. Operator-readable, never user-exposed.

---

## 15. Notifications — `notifications`

| Field | Type | Req | Notes |
|---|---|---|---|
| `recipientId` | Id | yes | |
| `event` | `"AUCTION_RESULT" \| "WINNER_NOTIFICATION" \| "SETTLEMENT_DEADLINE" \| "SETTLEMENT_REMINDER" \| "SETTLEMENT_FAILED" \| "REFUND_COMPLETED" \| "FULFILLMENT_UPDATE" \| "SYSTEM"` | yes | closed union (in-app + SMS events only) |
| `channel` | `"in_app" \| "sms"` | yes | **frozen channel set — no email** |
| `status` | `"PENDING" \| "SENT" \| "FAILED"` | yes | send-state; retries mutate only this field |
| `dedupeKey` | string | yes | **unique** `(event, recipient, channel)` composite — duplicates structurally impossible. FROZEN |
| `bodyKey` | string | yes | i18n key (EN/AM rendered at display) |
| `relatedEntityType` / `relatedEntityId` | string / Id | optional | deep-link target |
| `createdAt` / `sentAt` | number | yes / optional | |

**Indexes:** `by_dedupeKey` (unique), `by_recipient_created`, `by_status`.

---

## 16. Rate/Abuse Records — `abuseCounters`

| Field | Type | Req | Notes |
|---|---|---|---|
| `subject` | `"otp_request" \| "otp_verify" \| "bid_submit" \| "deposit_init" \| "withdrawal_req"` | yes | |
| `subjectId` | string (phone hash or user id) | yes | |
| `windowStart` | number | yes | |
| `count` | number | yes | |

**Indexes:** `by_subject_window`.
**FROZEN constraint:** throttling is generic anti-abuse only — **not** a bid-count cap (existence/value **OPEN**). Thresholds IMPL configuration.

---

## 17. Operator Records

- Operator identity = `users.role: "operator"` — no separate table (naming/hierarchy **OPEN**; the single-role field admits tiers later without migration).
- Every privileged action is attributed via `auditEvents` (`actorRole: "operator"`). That audit trail **is** the operator record. IMPL.
- Exception queues (payment, financial/reconciliation, fulfillment, notification, withdrawal) are **derived views** over `paymentEvents` (unconfirmed), reconciliation outputs, `fulfillmentRecords` (FAILED/UNRESOLVED), `notifications` (FAILED, retries exhausted), and `withdrawalRequests` — no separate queue tables in V1. IMPL.

---

## 18. Public vs Private Projections (query-layer contract)

Raw documents are never returned; prohibited fields are structurally absent (TRD §19). FROZEN.

### 18.1 Public projections (any visitor)
- **Catalog card:** auction `code, title, prize summary/images, status (SCHEDULED/OPEN/SETTLED only — DRAFT and CLOSED-internal never listed), startAt/closeAt, fulfillmentMethod, feeSantim (only when configured)`.
- **Live auction detail (OPEN):** card fields + countdown source (`closeAt`) + bounds (only when configured). **Never:** other bids, distribution, aggregate counters (unless the live-counter question is approved — default OFF), uniqueness data, ranking, current winner, lowest-unique value. No field exists to leak.
- **Settled result (exactly the frozen projection):** `result (WINNER/NO_WINNER)`, `winningAmountSantim` (when winner), `closeTime`, `finalAcceptedBidCount`, prize info, `winner display name` **only if** `publicWinnerConsent && publicDisplayName` (else "chose to stay anonymous"). Nothing else — no statistics, no distribution, no bid data.

### 18.2 Private/self projections (owner only)
- **Own bids (live):** own `amountSantim` + `status` (transactional only). Never uniqueness/ranking — even privately.
- **Own bids (post-close):** own `amountSantim`, `feeSantim`, `refundStatus`. Exactly the frozen self-view B.
- **Wallet:** `availableSantim`, history joined from `ledgerEntries` where `userSide = caller` (deposits, bid fees, refunds, settlements, withdrawals), each row's status + reference code.
- **Notifications:** own rows. **Fulfillment:** own record incl. own address.
- **Settlement (winner):** own pending/paid state + deadline.

### 18.3 Operator projections (privileged, audit-attributed)
Everything in 18.2 for support purposes **plus**: full settlement/financial detail, provenance/ledger inspection, reconciliation outputs, inventory reservation history, exception queues, abuse-counter signals. Never exposed publicly or cross-user beyond support needs.

### 18.4 Structural blind-bidding guarantee
The live-blindness rules hold **by construction**: no distribution/counter table exists (§9), no uniqueness/ranking fields exist anywhere (§9, §10), and the only accepted-bid statistic surfaced publicly is the **final** count written at finalization. A query cannot reveal what the schema does not store.

---

## 19. Consistency Check (vs. PRD/TRD)

1. **Lifecycle** `DRAFT → SCHEDULED → OPEN → CLOSED → SETTLED` exactly; no CLOSING state; settlement-pending modeled inside CLOSED via `settlementRecords.status = "pending"`. ✔ TRD §9/§11
2. **Inventory** RESERVE→COMMIT and RESERVE→RELEASE modeled with status union + reason; RESERVE is the sole publish gate; COMMIT only within settlement. ✔ TRD §12
3. **Ledger truth / wallet projection** append-only entries + postings; wallet updated only in-transaction; reconciliation via per-account sums. ✔ TRD §6
4. **Provenance** lots + `provenanceLotIds` tags on refund credit postings and `bidRefunds`. ✔ TRD §6/§11
5. **Integer santims** everywhere; no float fields. ✔ PRD §5.1
6. **Idempotency** unique keys on every economic op + general registry. ✔ TRD §16
7. **Blind bidding** structural: no distribution/counter/uniqueness/ranking data exists to leak; final accepted-bid count only. ✔ TRD §19
8. **Public result projection** field-for-field the frozen set, consent-gated name. ✔ TRD §19 / PRD §14
9. **Refunds** wallet destination, per-bid uniqueness, provenance tagging; no refunds on WINNER settlements. ✔ PRD §9 / TRD §11
10. **Payments** provider-verified confirmation before journaling; provider-ref uniqueness. ✔ TRD §7
11. **Withdrawals** record modeled, parameters OPEN, no payout mechanism locked. ✔ TRD §13
12. **Notifications** `(event, recipient, channel)` dedupe; in-app+SMS only. ✔ TRD §15
13. **Roles** two classes via `users.role`; naming OPEN; operator audit attribution. ✔ TRD §5
14. **No invented values:** fee, bounds, anti-snipe, deadline, withdrawal, KYC, provider config — all modeled as optional config fields, unset while OPEN. ✔

No contradictions found.

---

## 20. OPEN Decisions Preserved

1. Bid-fee model and exact amount (`feeSantim` optional/unset).
2. Min/max bid bounds (fields exist; values unset).
3. Same-user same-amount repeat rule (validator config flag).
4. Per-user bid-volume cap (none modeled; anti-abuse counters are not a cap).
5. Anti-snipe window/extension/max parameters (config fields, unset).
6. Settlement deadline duration.
7. Chapa deposit channels; links.et verification scope.
8. Withdrawal parameters and payout mechanism (record modeled, rules unlocked).
9. KYC/identity depth beyond verified phone.
10. Live accepted-bid counter (default OFF; no counter fields exist).
11. Proof-of-fulfillment artifact format (generic reference field).
12. Operator role naming/hierarchy (single `role` field admits refinement).
13. SMS provider for OTP/notifications (schema-neutral).
14. Inventory line backing multiple concurrent auctions (quantity field admits it; default dedicated line).
15. Delivery coverage / pickup location specifics (operator-configured generic fields).

---

*End of Backend Schema (v1.0). No Convex code written; `src/convex/schema.ts` and all implementation files untouched — design artifact only.*
