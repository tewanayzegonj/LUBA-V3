# LUBA — V1 Technical Requirements Document

**Document status:** FINAL (v1.0). Approved PRD correction pass and TRD correction pass applied; small inventory wording clarification applied (§12).
**Basis:** Approved LUBA V1 PRD (product authority). This TRD defines *how* the product is built. **Tags:** `[FROZEN]` = dictated by PRD; `[OPEN]` = undecided upstream or technical decision requiring owner input; `[IMPL]` = implementation detail within frozen constraints.
**Companion documents (separate, forthcoming):** Backend Schema, UI/UX Design Brief, Implementation Plan.
**Platform:** React 19 + Vite + TypeScript SPA, Convex backend/database/auth, Tailwind v4 + shadcn/ui, Bun. Single Convex deployment, single web app. No microservices, Redis, Kafka, or external queues. `[IMPL]`

---

## 1. Technical Architecture

- **[FROZEN]** One TypeScript monorepo app: React SPA (frontend) + Convex functions (backend/database) — the existing project stack.
- **[FROZEN]** Convex is the only backend: queries/mutations/actions, scheduled functions, HTTP endpoints for payment webhooks.
- **[IMPL]** Layering inside Convex:
  - `pure/` — pure deterministic functions (winner determination, fee math, provenance lot allocation, validation). No side effects; unit-testable.
  - `economic/` — mutations that move money; each is one serializable transaction wrapping: state guard → validation → ledger journal write → wallet projection update → lot update → entity status update → audit event.
  - `api/` — queries exposing projections to the client (public result, own bids, wallet, notifications). Queries never expose prohibited data (§19) and never write.
  - `actions/` — `"use node"` side-effectful integrations (Chapa, links.et, SMS). Actions never write money directly; they confirm through `economic/` mutations.
  - `jobs/` — scheduled functions (open/close sweeps, settlement-deadline sweep, reconciliation, notification retries).
- **[FROZEN]** All money math in **integer santims**; no floats anywhere in the product (including client display math, which formats integers).

## 2. Frontend Architecture

- **[IMPL]** React Router 7 routes: public landing/auction catalog, `/auth`, protected app (auction detail, wallet, my bids, notifications, fulfillment), operator console (role-gated).
- **[IMPL]** Real-time via Convex subscriptions (`useQuery`) for: auction state/closeTime, own bids, wallet balance, notifications, fulfillment status. No duplicated server state in client stores.
- **[IMPL]** Client countdown = server-provided `closeTime` + local monotonic ticker; **display only** — all decisions server-side. `[FROZEN: server authority]`
- **[IMPL]** Forms: react-hook-form + zod; amounts entered as strings, parsed to integer santims by a shared pure parser (no float arithmetic).
- **[IMPL]** The bidding surface presents only: bid fee (once `[OPEN]` fee frozen), amount input with bounds, and the transactional status of the user's own bid (submitted/accepted/rejected). Presentation details — loading states, toast vs. inline display, component choices — are delegated to the UI/UX Design Brief.

## 3. Backend / Convex Architecture

- **[IMPL]** Modules mirror §1 layering; one file per domain (auctions, bids, wallet, ledger, payments, withdrawals, fulfillment, notifications, users, audit).
- **[IMPL]** No return-type validators; document IDs typed `Id<T>`; schema validation handled in the Backend Schema document (not here).
- **[FROZEN]** Every economic mutation is a single Convex transaction — atomic and serializable; Convex OCC retries conflicts automatically.
- **[IMPL]** Hot-write avoidance: no per-auction aggregate counter document written on every bid (would serialize all bidders). Accepted-bid counts come from indexed count queries.
- **[IMPL]** Scheduled functions (`crons`) perform authoritative lifecycle transitions proactively as the operational backstop; correctness never depends on cron timing because deadline guards are enforced inside transactional mutations (§9, §17).

## 4. Authentication Architecture

- **[FROZEN]** Phone number + OTP is the primary and only auth method; anonymous sign-in is disabled and its token path is never accepted for any route. Email is an optional profile field, not an auth method.
- **[IMPL]** OTP codes: random, hashed at rest, short TTL, single-use, attempt-limited, resend cooldown; uniform responses to prevent phone-number enumeration.
- **[FROZEN]** `phoneVerified` flag on the user record; set only after successful OTP verification.
- **[FROZEN]** Verified phone = primary fulfillment contact; normalized to E.164 at registration.
- **[OPEN — technical, needs owner input]** (a) SMS provider for OTP and notifications with Ethiopia delivery coverage; (b) the template marks the existing Convex Auth files (`auth.config.ts`, `auth.ts`, `auth/emailOtp.ts`) as do-not-modify — adding a phone-OTP provider likely requires either a new custom provider file alongside them or platform approval to modify. Flagged as a dependency/decision, not silently worked around.
- **[IMPLEMENTATION NOTE — boundary established, decision NOT resolved]** The provider-neutral identity boundary now exists: `src/convex/guards/auth.ts` (single identity-lookup/authorization boundary) and `src/convex/profile.ts` (`ensureLubaIdentity` internalMutation — the registration-defaults entry point called only AFTER successful OTP verification). Whatever provider is chosen must (1) deliver OTP codes, (2) verify them, then (3) call `ensureLubaIdentity` inside the verification transaction; nothing else in the codebase depends on the provider choice. Phone input canonicalization is centralized in `src/convex/domain/phone.ts` (`PHONE_POLICY` — the single point to adjust if numbering policy changes).

## 5. Authorization / Security Boundaries

- **[FROZEN]** All authorization is server-side in every function; the client is untrusted UI.
- **[IMPL]** Guard primitives: `requireUser`, `requireVerifiedPhone` (all financial operations: deposits, bids, withdrawals, settlement), `requireOperator` (auction CRUD, inventory, fulfillment, settlement ops).
- **[FROZEN]** V1 has two privilege classes: regular users (bidders) and privileged operators. Regular users cannot perform operator actions; there is no seller role in V1.
- **[OPEN]** Exact privileged role names, hierarchy, and whether multiple privileged tiers are needed (e.g., operator vs. admin). The PRD does not freeze role naming; the TRD only requires that privileged operations are gated by a server-side, centralized authorization check.
- **[IMPL]** Ownership checks: wallet/bids/notifications/fulfillment readable only by owner (or privileged operators); no client-supplied amounts, fees, prices, or statuses are ever trusted; all amounts recomputed server-side.
- **[IMPL]** Privileged actions are audit-logged (§20).

## 6. Wallet and Double-Entry Ledger Architecture

- **[FROZEN]** The **ledger is the financial truth**: append-only, immutable journal. Every economic event = one balanced journal entry with ≥2 postings (debit/credit), integer santims, currency ETB.
- **[FROZEN]** The **wallet is a projection**: a cached available-balance document updated *in the same transaction* as its journal entry. Never the source of truth; reconciled periodically against ledger sums (§25).
- **[IMPL]** Chart of accounts (small, fixed): per-user wallet account; platform accounts for bid-fee revenue, settlement revenue, deposit clearing, withdrawal clearing; provider settlement accounts. Account/ledger class is never changed silently on a refund path. `[FROZEN: provenance]`
- **[FROZEN]** **Funding provenance:** deposits create **provenance lots** (per user: deposit reference, remaining amount). Debits consume lots and refunds credit the wallet tagged with the lot(s) that originally funded the refunded bid — traceable end-to-end, never reclassified.
- **[IMPL]** **Lot-consumption ordering** (e.g., FIFO) is an implementation choice only — not a product requirement. The exact lot-selection algorithm is owned by the financial/schema implementation layer (Backend Schema document) and must satisfy only the frozen invariant: every refund re-credits against the provenance that funded it.
- **[FROZEN]** **Idempotency:** every economic operation carries a unique idempotency key (client op id or server operation id) with a unique index; replay of the same key is a no-op returning the original outcome. Journal entries reference the idempotency key.
- **[FROZEN]** **Balance guard:** a bid (or any wallet debit) with insufficient available balance creates **no economic effect** — rejected transactionally before any write.
- **[IMPL]** Available-balance semantics: simple balance check at execution time; no holds/reservations on wallet balance in V1 (PRD requires sufficient balance *by the deadline* for settlement; the void-and-refund policy already covers spend-then-fail). Noted as an accepted product consequence, not changed.

## 7. Payment-Provider Architecture

- **[FROZEN]** **Chapa** (hosted payments) and **links.et** (receipt/reference verification where applicable) are the only providers; both feed one shared path: *provider event → payment-confirmation (server-verified) → double-entry journal → wallet credit*.
- **[IMPL]** Chapa integration = direct HTTPS from Convex actions (`"use node"`); checkout initiated server-side; client receives only a hosted-payment URL.
- **[IMPL]** Confirmation flow: hosted-checkout return and/or webhook hits a Convex HTTP endpoint; server verifies the payment with the provider (server-to-server) and/or verifies receipt/reference via links.et; only then journals the deposit and credits the wallet. Client-claimed success is never trusted.
- **[FROZEN]** Provider secrets exist only in platform-managed server env vars; never in client code or responses.
- **[FROZEN]** Deposit confirmation is idempotent: provider reference/transaction id has a unique constraint; replays credit nothing.
- **[OPEN]** Exact deposit channels exposed through Chapa; exact links.et verification scope ("where applicable" — which flows use it); Chapa webhook configuration/endpoint details.

## 8. Bid Transaction Architecture

- **[FROZEN]** One mutation, one transaction: `placeBid(auctionId, amountSantim, idempotencyKey)`:
  1. Guards: authenticated, `phoneVerified`, auction state = OPEN, server time < authoritative closeTime.
  2. Validate amount: integer santims, min/max bounds (values `[OPEN]`, logic `[FROZEN]`).
  3. Fee computation: server-side, per frozen fee model (model + amount `[OPEN]`).
  4. Balance guard → debit wallet (journal + projection + lot consumption).
  5. Write bid record (status ACCEPTED) + audit event.

  Any failure ⇒ transaction aborts ⇒ zero economic effect. `[FROZEN: balance guard]`
- **[FROZEN]** Bid acceptance returns **transactional status only** (accepted/rejected + reason class such as insufficient funds or too late). Never uniqueness/duplication/position. Live own-bid list may show own amounts + status; nothing else. `[FROZEN: blind]`
- **[IMPL]** Same-user same-amount repeats: enforced per decision — currently `[OPEN]`; the validator is a config flag, not an assumption.
- **[IMPL]** Late bids (server time ≥ closeTime, including anti-snipe-adjusted closeTime) are rejected deterministically.
- **[IMPL]** Rate limiting on bid submission is generic anti-abuse throttling only (§22) — **not** a bid-count cap (cap existence/value `[OPEN]`).

## 9. Auction Lifecycle / State Handling

- **[FROZEN]** State machine: `DRAFT → SCHEDULED → OPEN → CLOSED → SETTLED`; transitions only via guarded mutations that check current state inside the transaction.
- **[FROZEN]** No public CLOSING state; anti-snipe adjustments mutate `closeTime` while state stays OPEN.
- **[Finalization model]**
  - **Correctness never depends on cron timing:** every deadline is enforced *inside transactional mutations* at execution time — a bid submitted at/after the current server-side `closeTime` is rejected by the bid mutation's guard; a settlement attempted after the deadline is rejected by the settle mutation's guard. No late economic effect can occur regardless of when scheduled work next runs.
  - **State-changing transitions occur only through mutations** — invoked directly by guarded user/operator actions, or by scheduled function runs that call internal mutations. Ordinary queries **never** perform transitions or any write; they may compute *display-only derived status* (e.g., rendering "bidding has ended" for an auction past its close time) without mutating.
  - Scheduled sweeps remain the operational backstop that performs authoritative transitions proactively (OPEN→CLOSED, CLOSED→SETTLED on deadline failure).
- **[CLOSED meaning]** `CLOSED` = bidding has ended and the result has been deterministically determined at finalization; if the result is WINNER, the auction holds in CLOSED with **settlement pending** (see §11) until settlement succeeds (→ SETTLED(WINNER)) or the deadline passes (→ SETTLED(NO_WINNER)). CLOSED is therefore not an immediately terminal state.
- **[FROZEN]** Multiple concurrent OPEN auctions; no artificial concurrency cap; per-auction configured start/end; operator may schedule ahead or open directly. Operator tooling minimal (create, configure, publish, open, view results).

## 10. Winner Determination

- **[FROZEN]** Pure, deterministic function over accepted bids: group by `amountSantim`; candidates = amounts with count == 1; winner = bid with minimum such amount; no candidates ⇒ NO_WINNER. No runner-up list, no tiebreaker.
- **[IMPL]** Executed once at finalization (OPEN→CLOSED) inside the finalization transaction; result stored on the auction (WINNER + winning bid ref, or NO_WINNER). Re-execution is idempotent by state guard and yields the identical result. `[FROZEN: exactly one deterministic result]`
- **[IMPL]** Scale: indexed scan of accepted bids per auction; adequate for V1; pure function fully unit-tested.

## 11. Settlement and Refund Processing

**Phase 1 — Close and result determination (OPEN → CLOSED):**
- At/after the authoritative close time, a finalization mutation determines the result via the pure function (§10): single lowest unique accepted bid, or NO_WINNER. Deterministic and idempotent (state guard).
- **NO_WINNER at close:** the shared refund engine runs (below); inventory reservation is RELEASED (§12); auction → **SETTLED(NO_WINNER)**. No extension, reopen, or tiebreak. `[FROZEN]`
- **WINNER determined:** the auction **remains CLOSED with settlement pending**; the inventory reservation stays held; the settlement deadline (duration `[OPEN]`, configurable) begins; winner notification (SMS + in-app) is emitted per §15. `[FROZEN: deadline-bound settlement]`

**Phase 2a — Successful settlement (CLOSED → SETTLED(WINNER)):**
- `settle(auctionId, idempotencyKey)`: guards — state CLOSED, result WINNER, caller = winner, `phoneVerified`, server time ≤ deadline.
- One transaction: wallet balance ≥ winning amount → wallet debit (separate settlement journal entry, distinct account/ledger class from bid fees) → inventory COMMIT (§12) → auction → SETTLED(WINNER) → audit.
- Atomic + idempotent; replay returns the original outcome. No external settlement payment path. `[FROZEN]`

**Phase 2b — Deadline failure (CLOSED → SETTLED(NO_WINNER)):**
- A scheduled sweep mutation checks: if settlement pending and server time > deadline → deterministic transition to SETTLED(NO_WINNER) + inventory RELEASE + full bid-fee refunds (including the defaulting winner). Idempotent per auction and per bid. `[FROZEN: void-and-refund]`
- No runner-up, no re-award, no operator discretion in the normal V1 failure path. `[FROZEN]`

**Refund engine (shared by Phase 1 NO_WINNER and Phase 2b):** `[FROZEN]`
- Per accepted bid, exactly once: credit the bidder's wallet (journal + projection) tagged with that bid's consumed provenance lot(s); mark the bid `refunded` in the same transaction; per-bid idempotency key prevents duplicate credit. No external auto-refund.
- Auctions settled with WINNER: no fee refunds. `[FROZEN]`

**Explicit invariant:** `[FROZEN]` every auction reaches SETTLED exactly once, with exactly one final result; CLOSED auctions with a WINNER do **not** become SETTLED until the settlement window resolves (success or deadline failure).

## 12. Inventory Reservation

- **[FROZEN]** Prize inventory is operator-managed; reservation is atomic; a prize cannot be promised to more than one winner; inventory is released on void.
- **[IMPL — terminology]** Three inventory operations, used consistently throughout this document and the Backend Schema:
  - **RESERVE** — atomically hold inventory for a specific auction.
  - **COMMIT** — permanently consume a held reservation, converting it into a winner's entitlement.
  - **RELEASE** — return a held reservation to available inventory.
- **[Reservation timing]**
  - **RESERVE at auction creation/configuration:** when the operator creates/configures the auction with a prize, an atomic reservation transaction conditionally decrements the inventory line's `available` count (concurrent reservation attempts serialize in the transaction; a losing attempt fails with insufficient availability). An auction **cannot be published/opened without a secured reservation** — it can never promise inventory it does not hold.
  - **COMMIT at successful settlement:** when the winner successfully settles (Phase 2a, §11), the reservation is committed in the same transaction as settlement.
  - **RELEASE on:** (a) **void** (settlement-failure path, Phase 2b, §11); (b) **terminal NO_WINNER at close** — the reservation was held from creation but was never converted into a promise, so it is released unchanged; (c) **operator cancellation of an auction that has not yet opened** (handled as a cancellation transition; no new public lifecycle state is introduced). RELEASE restores the reserved quantity to `available` atomically.
- **[IMPL]** Because RESERVE precedes any promise, concurrent auctions physically cannot promise the same physical inventory: the reservation transaction is the sole gate, and over-promising is structurally impossible rather than detected after the fact.
- **[OPEN — technical]** Whether one inventory line may back multiple concurrent auctions by quantity (mechanically supported by the RESERVE/RELEASE model); default V1: dedicated line per auction.

## 13. Withdrawal Architecture

- **[FROZEN]** V1 supports withdrawals at the policy level; all parameters are `[OPEN]` upstream (minimum amount, fees, payout methods, KYC, limits/cooldowns, manual approval, eligibility).
- The TRD deliberately does **not** lock V1 to a specific payout-provider mechanism, payout rail, or approval workflow. Withdrawal execution sits behind a provider-agnostic payout interface; the concrete mechanism is decided only when the PRD withdrawal parameters freeze.
- **[IMPL — invariants independent of mechanism]**
  - A withdrawal is an economic operation on the authoritative ledger: wallet debit with provenance-consistent accounting, idempotency key, and reconciliation coverage like every other money movement.
  - Once a withdrawal is in flight, the accounting must ensure the debited funds cannot be double-spent; the exact mechanism (debit-on-request, debit-on-approval, or balance holds) is an implementation decision deferred to the financial/schema layer. `[OPEN — IMPL]`
  - Payout confirmation, whether provider-executed or operator-executed, enters the ledger through the same verification-before-journaling discipline as deposits (mirror direction).
  - All withdrawal parameters are read from configuration; nothing is implemented or defaulted while `[OPEN]`.

## 14. Fulfillment Architecture

- **[FROZEN]** Physical prizes only; methods: operator delivery (primary) or local pickup (alternative), configured per prize/auction; lifecycle/status tracking; proof/verification required at completion; starts only after settlement.
- **[IMPL]** Fulfillment record per settled winner; status flow kept minimal: `PENDING → [ADDRESS_SUBMITTED|INSTRUCTIONS_SENT] → IN_PROGRESS → COMPLETED (with proof) | FAILED/UNRESOLVED`. Exact vocabulary tunable in Backend Schema.
- **[IMPL]** Delivery: winner submits delivery address (validated, stored with fulfillment record — sensitive data, §19/§20). Pickup: pickup instructions + status updates; pickup verification recorded as proof.
- **[IMPL]** Operator console: update status, attach proof/verification reference (e.g., receipt/confirmation code; photo upload scope `[OPEN — technical]`), mark completion.
- **[FROZEN]** No digital-code delivery, no prize-to-wallet credit mechanisms.

## 15. Notification Architecture

- **[FROZEN]** Channels: in-app + SMS only. SMS to verified phone for: winner notification, settlement deadline/reminders, settlement failure/NO_WINNER, fulfillment/pickup/delivery updates. In-app: status history, auction result, settlement status, fulfillment status.
- **[FROZEN]** Idempotent + auditable: each notification = a record with unique key `(event, recipient, channel)`; send actions track `PENDING/SENT/FAILED` with retries; the record is the audit trail. Duplicate sends impossible by unique constraint.
- **[IMPL]** SMS via one provider action (`"use node"`); provider choice `[OPEN]` (§4). In-app = queryable notification documents.
- **[FROZEN]** No email channel requirement; no additional channels; no broad notification platform.

## 16. Idempotency and Concurrency Strategy

- **[FROZEN]** Convex mutations are serializable transactions — the concurrency foundation. No external locks.
- **[IMPL]** Patterns:
  - **Idempotency keys** on all economic mutations (bid, deposit confirm, settlement, refund per bid, withdrawal, notification send) with unique indexes; replays no-op.
  - **Conditional state transitions** (state checked in-transaction) make lifecycle and settlement naturally exactly-once.
  - **Hot-write avoidance**: no global counters in bid path; lot allocation and wallet docs serialize only per-user operations (acceptable).
  - **Deterministic retries**: provider-facing actions retry with the same idempotency key; confirmations verify before journaling.
- **[FROZEN]** Wallet+ledger+entity updates are atomic in one transaction; no partial money states can exist.

## 17. Server-Authoritative Time

- **[FROZEN]** The server clock is the only decision clock. Convex transaction timestamps used for close checks, deadline checks, and record times. The client only renders countdowns from server-provided times and never inputs a time. Client clock skew cannot affect any decision.
- **[IMPL]** All times stored as UTC epoch millis.
- **[IMPL]** **Africa/Addis_Ababa is the default presentation timezone only** — a display/configuration default, not an irreversible product constraint; per-user or operator-configurable presentation timezone may be introduced later without data or logic changes.
- **[ASSUMPTION]** Convex's backend clock is platform-managed and NTP-synced; no self-hosted time infrastructure is introduced.

## 18. Anti-Sniping Architecture

- **[FROZEN]** Anti-sniping is supported; any extension is deterministic and server-controlled; there is no public CLOSING state — the auction remains OPEN with an adjusted authoritative `closeTime`.
- **[IMPL]** Mechanism: inside the bid transaction, if server time falls within the anti-snipe trigger window before `closeTime`, the same transaction extends `closeTime` by the configured duration, bounded by the configured maximum number of extensions; the extension is recorded as an audit event. All three parameters are **[OPEN]** and read from configuration — no defaults are invented.
- **[IMPL]** Extended `closeTime` propagates to clients via the existing auction subscription; the countdown re-renders. Late-bid rejection always evaluates against the *current* server-side `closeTime`.
- **[FROZEN]** Determinism: given the same bid sequence, extensions are reproducible; repeated evaluation cannot double-extend beyond the configured maximum.

## 19. Public/Private Data Boundaries

- **[IMPL]** Projection layer: every client-facing query returns an explicitly whitelisted shape per surface — public catalog, public settled result, own bids, own wallet, own notifications, own fulfillment. Raw documents are never returned; prohibited fields are structurally absent, not merely hidden.
- **[FROZEN]** Live blindness enforced at the query layer: for an OPEN auction, no query exposes other bids, distribution, own-bid uniqueness/duplication/winning status, a live lowest-unique value, or ranking. Own bids show transactional status only.
- **[FROZEN]** Public settled result contains exactly: WINNER/NO_WINNER, winning amount (when winner), close time, final accepted-bid count, prize information, and winner display name **only** when `publicWinnerConsent === true` and `publicDisplayName` is non-null.
- **[FROZEN]** Post-close self-view contains exactly: own bid amounts, per-bid fee, refund status — never uniqueness/ranking (even privately) and never other bids.
- **[FROZEN]** Wallet, ledger, and settlement data are visible only to the owning user (their own projection) and operators — never in any public surface.
- **[OPEN — technical, needs owner decision]** Whether live auctions display an accepted-bid counter: the PRD freezes blindness over *amounts/distribution/ranking* and publishes a *final* accepted-bid count, but does not decide a live counter. Not assumed either way.

## 20. Privacy and Audit Logging

- **[FROZEN]** All notifications are idempotent and auditable; the ledger is the financial audit trail.
- **[IMPL]** Append-only audit log for: every economic operation (bid acceptance/rejection, deposit confirmation, settlement, refund, void, withdrawal transition), lifecycle transitions, anti-snipe extensions, inventory RESERVE/COMMIT/RELEASE, operator actions, and notification sends. Each record: actor, idempotency key, entity refs, integer amounts, server timestamp.
- **[IMPL]** Audit log is operator-readable (disputes, reconciliation) and never exposed to users; it never contains secrets or full PII (no OTP codes, no full addresses in audit records).
- **[IMPL]** PII minimization: phone (verified, E.164), optional email, delivery address stored only on the fulfillment record; server-only access; no PII in logs or client-exposed projections beyond frozen display needs.

## 21. Error Handling

- **[IMPL]** Deterministic error taxonomy surfaced as transactional status: validation (bounds/format), authorization (unverified phone, insufficient privilege), state (auction not OPEN, already settled), insufficient funds, too late. Every user-facing error is plain-language, bilingual (§23), and reveals nothing about other bids or uniqueness.
- **[IMPL]** Internal errors log with the idempotency key as correlation id; internals never reach the client.
- **[IMPL]** Provider-side failures: actions retry with backoff using the same idempotency key; an unconfirmed provider event never journals money; unresolvable items land in an operator exception queue (§25).
- **[IMPL]** Side-effect ordering: money state is only ever produced by transactions; if a post-commit side effect fails (e.g., SMS send), its notification record remains PENDING with retry — money truth never depends on side-effect success. Deposit confirmation is the one deliberate inversion: the verified provider event *is* the trigger for the journaling transaction.

## 22. Rate Limiting / Abuse Protection

- **[FROZEN]** Anti-abuse throttling may exist; it is **not** a bid-count cap (bid-volume limit remains **[OPEN]**).
- **[IMPL]** Time-window throttles enforced inside mutations (Convex-native, no Redis): OTP request cooldown + attempt limits, bid submission bursts, deposit initiation, withdrawal requests.
- **[IMPL]** Anomalous patterns (rapid rejected bids, OTP hammering) surface as observability signals for operator review; no automatic product consequences beyond throttling.
- **[OPEN — technical]** Specific threshold values; set as configuration during implementation, reviewed post-launch.

## 23. Internationalization

- **[FROZEN]** English + Amharic; mobile-first.
- **[IMPL]** Lightweight keyed dictionary i18n (no heavy framework); every user-visible string keyed; both languages shipped for all core flows at launch; language preference persisted per user; `<html lang>` reflects active language.
- **[IMPL]** Money display: single shared formatter converts integer santims → ETB display strings (display-only division; stored values remain integer santims — no float rounding anywhere). Dates render in the presentation timezone (default Africa/Addis_Ababa; presentation-only, per §17).

## 24. Accessibility Requirements

- **[IMPL]** Target: **WCAG 2.2 AA**. Implementation: semantic HTML; shadcn/Radix primitives (built-in a11y) by default; full keyboard navigability; focus management and scroll containment in dialogs; labeled inputs with announced errors; contrast-checked theme in light/dark; `prefers-reduced-motion` respected for Framer Motion animations; countdown rendered accessibly (`aria-live="polite"`, throttled announcements).

## 25. Observability and Operational Requirements

- **[IMPL]** Structured logging in actions (no secrets, no PII); Convex dashboard for function errors; template instrumentation entrypoint preserved.
- **[IMPL]** Reconciliation job (scheduled): (a) every journal entry debits == credits (invariant), (b) wallet projection sums == ledger sums per user, (c) orphaned/unconfirmed payment confirmations, (d) duplicate/replay attempt counters. Exceptions feed the operator console.
- **[IMPL]** Operator exception queues: unconfirmed payments, failed payouts, failed notifications (retry-exhausted), unresolved fulfillments, reconciliation mismatches.
- **[FROZEN-mapping]** Metric counters map to the six PRD categories (PRD §4); numerical targets **[OPEN]**.
- **[OPEN — technical]** Alerting thresholds/channels beyond the Convex dashboard.

## 26. Testing Strategy

- **[IMPL]** Pure-function unit tests (exhaustive): winner determination (no bids; single bid; all amounts duplicated; multiple unique amounts; duplicate-low edge), fee math (once frozen), provenance lot allocation (partial consumption, refund re-crediting; ordering algorithm per financial layer), santim parsing/formatting.
- **[IMPL]** Economic-mutation scenario tests: replay idempotency keys to assert exactly-once; insufficient-funds rejection leaves zero effect; late-bid rejection; settlement deadline void-and-refund determinism.
- **[IMPL]** State-machine tests: legal/illegal lifecycle transitions, concurrent double-transition attempts, anti-snipe extension bounds, inventory RESERVE/COMMIT/RELEASE races.
- **[IMPL]** Privacy-boundary tests: assert whitelisted projections never contain prohibited fields (live blindness, public result, own-bids views).
- **[FROZEN-consistency]** Automatable PRD acceptance criteria (AC-B1…AC-U1) are encoded as executable checks.
- **[CONSTRAINT]** No browser automation exists in this environment (capability report): rendered E2E verification is owner-performed via preview against a supplied checklist; automated coverage is limited to unit/scenario layers plus typecheck/lint gates.

## 27. Deployment / Environment Requirements

- **[IMPL]** Environments: Convex dev deployment + platform preview for development; production Convex deployment + built frontend via the platform. Convex pushes are platform-run (`convex dev --once` locally for codegen only).
- **[FROZEN]** Secrets are platform-managed env vars only: existing (CONVEX_DEPLOYMENT, VITE_CONVEX_URL, JWKS, JWT_PRIVATE_KEY, SITE_URL) plus new provider keys (Chapa, links.et, SMS). Never committed; only `VITE_CONVEX_URL` is client-exposed.
- **[IMPL]** Runtime configuration for tunables (anti-snipe params, deadline duration, fee once frozen, bounds once frozen) held in a server-only config source; unset while decisions are **[OPEN]**.
- **[IMPL]** Schema changes deploy as code with the Convex push; no separate migration system for V1. Typecheck (`bun tsc -b --noEmit`) is the pre-merge gate; lint errors in new code are fix-on-sight.
- **[ASSUMPTION]** The platform's managed deploy pipeline remains the only deployment mechanism.

## 28. Security Requirements

- **[FROZEN]** Server-side authorization in every function; the client is untrusted.
- **[IMPL]** No client-supplied amounts, fees, prices, deadlines, or statuses are ever trusted — all recomputed server-side from authoritative records.
- **[IMPL]** Webhook/HTTP endpoints: provider signature verification (Chapa), unguessable paths, secret-bearing headers, idempotent ingestion; uniform OTP responses prevent phone enumeration; codes hashed at rest, single-use, expiring, attempt-limited.
- **[IMPL]** Ownership enforcement on all private projections (wallet, bids, notifications, fulfillment/address data) — IDOR-resistant by construction.
- **[IMPL]** Dependency discipline: versions pinned in `bun.lock`; audit before adding any package; minimal new dependencies.
- **[IMPL]** Audit logging (§20) as insider-misuse deterrent; operator actions always attributed.

## 29. Performance Requirements

- **[IMPL — non-contractual engineering targets only; NOT PRD requirements]** The approved PRD contains no performance requirements, and none may be implied: bid-placement round-trip p95 < 1s; subscription updates visible < 1s after commit; smooth catalog scrolling on mid-range mobile devices; winner determination as an indexed per-auction scan adequate at assumed V1 scale (see Assumptions).
- **[IMPL]** Hot-write avoidance (no per-bid aggregate counters) keeps bid-path transactions contention-free across users; per-user wallet/lot writes serialize only per user.
- **[OPEN — technical]** Contractual SLOs, if ever required, are set post-baseline by the owner.

## 30. Technical Risks and Mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Phone-OTP may require modifying template files marked do-not-modify | Flag for platform approval early; isolate a new provider file; do not silently fork auth |
| 2 | Chapa webhook loss/failure | Server-to-server verification as primary truth; hosted-checkout return verification as backup; exception queue + reconciliation |
| 3 | links.et scope unclear (**[OPEN]**) | Hide behind a verification interface; no flow depends on it until frozen |
| 4 | SMS deliverability/cost in Ethiopia | Provider selection **[OPEN]**; idempotent retry + audit; in-app channel always available as fallback |
| 5 | Bid-burst OCC contention on a hot auction | Independent bid documents, no shared counters; retries are safe (idempotency keys) |
| 6 | Winner unaware of settlement deadline → avoidable voids | Mandated SMS deadline reminders + in-app status (PRD §12); top-up available during settlement window |
| 7 | Refund replay/duplication bugs | Per-bid idempotency keys + reconciliation invariants + scenario tests |
| 8 | Float leakage into money paths | Single shared integer-santim module; no `parseFloat` in money code; unit tests on parsing |
| 9 | Client clock skew | Server-authoritative only; countdown is display-only |
| 10 | Scope creep into deferred features | PRD §18 is authority; TRD implements none of it |

---

## Technical Decisions

1. Convex-only backend; layered function organization (pure / economic / api / actions / jobs); no external infrastructure.
2. Ledger-as-truth; wallet as same-transaction projection; provenance lots with refunds re-crediting tagged lots; lot-selection algorithm owned by the financial/schema implementation layer (`[IMPL]`, not frozen).
3. Idempotency-key records with unique indexes on all economic operations; conditional state transitions for exactly-once lifecycle.
4. Deadline guards enforced inside transactional mutations; scheduled sweeps perform authoritative transitions as the operational backstop; server transaction time as the only decision clock; queries strictly read-only.
5. Whitelisted query projections per surface; prohibited data structurally absent.
6. Notification records with unique `(event, recipient, channel)` keys; send actions retried against the record.
7. Integer-santim shared module for all parsing, math, and display formatting.
8. Provider confirmations verified server-to-server before any journaling; hosted-checkout + webhook ingestion.
9. Inventory model: RESERVE atomically at auction creation/configuration (publication requires a secured reservation); COMMIT within the settlement transaction; RELEASE on void / terminal NO_WINNER / cancel-before-open; dedicated inventory line per auction by default.
10. Config-driven tunables; unset while upstream decisions are **[OPEN]**.
11. Settlement phase model: CLOSED holds result-determined + settlement-pending; SETTLED(WINNER) on successful settlement only; SETTLED(NO_WINNER) on deadline failure.
12. Withdrawals behind a provider-agnostic payout interface; mechanism unlocked pending PRD `[OPEN]` parameters.
13. WCAG 2.2 AA accessibility target; UTC storage with Africa/Addis_Ababa as reversible default presentation timezone.

## Technical Open Questions

1. Phone-OTP provider mechanism vs. do-not-modify auth template files (platform approval required).
2. SMS provider with reliable Ethiopia delivery (OTP + notifications).
3. Chapa webhook configuration, signature scheme, exact deposit channels.
4. links.et verification interface scope ("where applicable" — which flows).
5. Live accepted-bid counter display on OPEN auctions (owner decision; not frozen by PRD).
6. Whether one inventory line may back multiple concurrent auctions by quantity (default: dedicated line per auction).
7. Proof-of-fulfillment artifact format (photo upload/storage vs. reference codes).
8. Withdrawal payout mechanism/rail and in-flight accounting mechanism — deliberately unlocked; blocked on PRD `[OPEN]` withdrawal parameters.
9. Exact privileged role names/hierarchy and tier structure (PRD freezes only the two-class, no-seller constraint).
10. Lot-selection algorithm for provenance consumption (financial/schema implementation layer; FIFO is one candidate).
11. Rate-limit threshold values.
12. Alerting channels/thresholds beyond the Convex dashboard.
13. Contractual SLOs (only if the owner requires them post-baseline).

## Security Risks

- OTP abuse (harnessing, SIM-swap exposure) → throttles, hashed single-use codes, uniform responses; KYC depth **[OPEN]** upstream.
- Webhook forgery/replay → signature verification, unguessable paths, idempotent ingestion.
- IDOR on addresses/fulfillment/wallet → server-side ownership checks on every private projection.
- Enumeration via error text → uniform transactional statuses.
- Insider/operator misuse → append-only audit log with attribution.
- Client-trust violations → server recomputation of all amounts/fees/deadlines.

## Operational Risks

- High NO_WINNER rate eroding trust → monitored via PRD metric 1 (targets **[OPEN]**; curation strategy is a product matter).
- Refund storms after failed settlements → batched idempotent refund engine; reconciliation checks.
- Payment-provider outages → exception queues, retry with same keys, manual reconciliation tooling.
- SMS delivery failure at critical moments → retries + audit; in-app fallback; operator visibility of exhausted notifications.
- Manual ops load (fulfillment, exceptions) → operator console queues designed for triage.

## Dependencies

- Convex platform (transactions, crons, auth, managed push/deploy).
- Chapa account, API credentials, webhook configuration.
- links.et integration specification.
- SMS provider account (to be selected — **[OPEN]**).
- Platform-managed env vars (existing auth/URLs + new provider keys).
- Existing template stack: React 19, Vite 7, Tailwind v4, shadcn/ui, Framer Motion, Bun, Convex Auth.

## Assumptions (explicitly labeled)

1. Convex backend clock is platform-synced; transaction timestamps are consistent within a mutation.
2. V1 per-auction accepted-bid volume is thousands, not millions — indexed scans suffice.
3. Convex cron granularity (minute-level) is adequate; deadline guards in transactional mutations cover the gap.
4. Chapa and links.et provide server-verifiable confirmation artifacts.
5. SMS OTP is an acceptable sole verification factor for V1 pending KYC decisions.
6. The platform remains the sole deploy/push mechanism; no self-managed backend.
7. No legal/regulatory gating blocks the build; regulatory review is an owner responsibility (PRD Q1 flagged pay-to-bid legal sensitivity).
8. EN + AM launch content covers all core flows.

---

## Final Contradiction Check (vs. approved PRD)

1. **Inventory reservation (PRD §10):** RESERVE-at-creation satisfies "reserved atomically" + "cannot be promised to more than one winner"; release-on-void is FROZEN; RELEASE on terminal NO_WINNER (held but never promised) and cancel-before-open is the mechanical complement of atomic reservation and adds no public lifecycle state — no contradiction with PRD §13. ✔
2. **Roles (PRD §5/§11):** PRD freezes no-seller-role and operator-curated auctions; it does not freeze role naming — correctly OPEN; "regular users cannot perform operator actions" preserved as frozen constraint. ✔
3. **Provenance (PRD §6/§9):** provenance preservation remains FROZEN; FIFO demoted to IMPL — the PRD never required FIFO. ✔
4. **Finalization (PRD §5.8, §13):** server-authoritative time and "exactly one deterministic terminal result" are enforced by mutation guards (queries cannot mutate); scheduled work performs transitions; no correctness dependency on cron timing. ✔
5. **Settlement vs. lifecycle (PRD §8/§13):** DRAFT→SCHEDULED→OPEN→CLOSED→SETTLED preserved with no new public state; settlement-pending is an internal sub-phase of CLOSED; SETTLED terminal exactly once; void-and-refund and no-runner-up intact. ✔
6. **Withdrawals (PRD §6/§14):** policy-level only; all `[OPEN]` parameters untouched; no payout mechanism locked. ✔
7. **Blind bidding (PRD §5.3/§14):** unchanged and intact; live-counter question remains flagged, not assumed. ✔
8. **Refunds (PRD §9):** wallet destination, provenance tagging, idempotency unchanged. ✔
9. **Integer santims (PRD §5.1):** unchanged. ✔
10. **Auth (PRD §11):** phone+OTP only, anonymous disabled, verified-phone gate — unchanged. ✔
11. **Notifications (PRD §12):** in-app + SMS, idempotent/auditable — unchanged. ✔
12. **Timezone:** UTC storage + server authority preserved; presentation default reversible — no PRD conflict. ✔
13. **Accessibility WCAG 2.2 AA:** internal engineering target; PRD contains no a11y requirement to contradict. ✔
14. **UI assumptions:** loading/presentation decisions delegated to UI/UX Design Brief — TRD does not pre-empt it. ✔
15. **Performance:** no invented numbers presented as PRD requirements; explicitly non-contractual. ✔

No contradictions remain.
