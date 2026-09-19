# LUBA — V1 Implementation Plan

**Document status:** FINAL (v1.0). The bridge from planning to engineering — the prescribed implementation sequence for Freebuff.
**Basis (authoritative, in order):** Approved PRD · `docs/luba-v1-trd.md` · `docs/luba-master-design-authority.md` · `docs/luba-v1-ui-ux-design-brief.md` · `docs/luba-v1-app-flow.md` · `docs/luba-v1-backend-schema.md`.
**This document contains no code.** It defines *what to build, in what order, gated by what checks*.

---

## 1. Implementation Principles

1. **Simple at the edges, strict at the core.** UI and CRUD stay boring; every rule that touches money, bids, settlement, inventory, or authorization lives in server-side, transactional, tested code.
2. **Server-authoritative business rules.** The client renders; the server decides. No client-supplied amount, fee, deadline, status, or time is ever trusted (TRD §5/§17/§28).
3. **Financial correctness before UI polish.** Ledger/provenance/idempotency (Phases B–E) land and are tested before any consumer surface that depends on them.
4. **Small focused changes.** One task = one coherent change set; no bundling of unrelated edits; every change typechecks.
5. **No speculative architecture.** No microservices, Redis, Kafka, extra backends, or abstractions beyond TRD's layering (`pure/economic/api/actions/jobs`).
6. **No fake business data.** No invented fees, bounds, deadlines, anti-snipe values, withdrawal rules, or seed prizes with fabricated economics. `[OPEN]` parameters remain unset; UI renders their absence honestly.
7. **No feature creep.** PRD V1 scope + frozen deferrals are authority (PRD §18). Deferred features (digital prizes, cash-to-wallet, seller marketplace, email OTP, multi-currency) are not built, stubbed, or half-wired.
8. **OPEN ≠ configured.** Every unresolved decision blocks only what it must; abstractions/config placeholders carry the seam, never a default value.

---

## 2. Repository / Foundation Preparation

### 2.1 Inspect current project (done — recorded)
React 19 + Vite 7 + TS 5.9 SPA, Convex 1.30 backend (`src/convex/`), Convex Auth (email OTP + anonymous providers), full shadcn/ui set, Tailwind v4, Bun 1.3.x, Framer Motion, Sonner, react-hook-form + zod, Recharts. Template pages (`Landing.tsx`, `Dashboard.tsx`, `Auth.tsx`) are starter scaffolding to be rebuilt, not preserved as business logic.

### 2.2 Preserve useful Phase 1 foundation
- **Keep:** `RequireAuth` wrapper + `returnTo` pattern (App Flow §21/§23 depends on it), `useAuth` hook wiring, `src/main.tsx`/`src/App.tsx` bootstrapping, Vite config (HMR settings untouched), ESLint/Prettier configs, `src/lib/utils.ts` (`cn`), platform-managed auth seams in `auth.config.ts` (freebuff federated provider preserved as-is).
- **Rebuild/replace:** template Landing/Dashboard/Auth visual content; template logo usage (replaced by BrandMark); starter schema comments.
- **Preserve behavior, replace visuals** — the auth/protect/route skeleton is correct; its look is not.

### 2.3 Files that must remain untouched
- `vly-toolbar-readonly.tsx` — read-only platform file (marked DO NOT MODIFY).
- `src/convex/auth.ts`, `src/convex/auth.config.ts`, `src/convex/auth/emailOtp.ts` — template marks these do-not-modify; **phone-OTP addition requires a new provider file + platform approval (TRD Open Question #1 / Phase C gate)** — never silent forking.
- `vite.config.ts` (except additive chunk entries if a new dependency requires one — never HMR settings).
- `src/main.tsx` global stylesheet import; Tailwind directives/theme variable block in `src/index.css` (extend, never delete).
- `.env` files (user-managed via platform Keys UI).

### 2.4 Dependency decisions
- **Add:** `motion` (current Motion ecosystem — replaces `framer-motion` usage; migrate template imports), font packages or self-hosted woff2 (Manrope, Fraunces, Noto Sans Ethiopic, IBM Plex Mono), `@fontsource/*` preferred; icon direction = Phosphor (`@phosphor-icons/react`) replacing restyled Lucide in new code (Lucide remains in template shadcn files until touched).
- **Do not add:** state managers, CSS-in-JS, heavy i18n frameworks (keyed dictionary per TRD §23), browser-automation deps into app runtime, chart libraries beyond existing Recharts (operator charts only, decision-gated).
- **Existing stack reuse:** react-hook-form + zod (forms/validation), Sonner (light confirmations), Radix/shadcn foundations (re-skinned to PULSE).
- **Testing:** add **Vitest** for pure-function/economic tests (TRD §26 layer). No E2E framework is added for in-repo automation (capability constraint TRD §26 constraint) — browser journeys are owner-verified per §8 below. Revisit only if the platform gains browser tooling.

### 2.5 Environment / secret boundary
- Secrets only via platform-managed env vars read in `"use node"` actions with `process.env`; never in client code, never in responses (TRD §27/§28). New keys expected: `CHAPA_SECRET_KEY`, links.et credential, SMS provider credential — added by owner via Keys UI when Phase E/K need them; code reads config, never values.
- Only `VITE_CONVEX_URL` is client-exposed (existing).
- Server-only runtime config module for `[OPEN]` tunables (fee, bounds, anti-snipe, deadline, withdrawal) — fields exist, **unset while OPEN**; code paths guard on absence and degrade to honest "not configured" states (App Flow §1).

### 2.6 Convex foundation
- Adopt TRD §1 layering as folders: `src/convex/pure/`, `economic/`, `api/`, `actions/`, `jobs/` + `schema.ts`. Codegen via `bun convex dev --once` only (non-interactive constraint); never hand-edit `_generated`.
- Rule: `api/` queries are read-only whitelisted projections; `economic/` mutations are the only money writers; `actions/` never journal money directly; `jobs/` are backstop sweeps calling internal mutations.

### 2.7 Testing foundation
- Vitest with two suites: `pure/` unit tests (deterministic functions) and `economic/` scenario tests (idempotent replay, insufficient funds, races). Seed pattern: construct documents in-memory or against dev deployment fixtures; no production data.
- Typecheck (`bun tsc -b --noEmit`) is the per-change gate; `bun convex dev --once` before frontend work that consumes new schema; lint clean on new code.

### 2.8 Design-system implementation foundation
- Token layer in `src/index.css` (extend): PULSE oklch tokens for Pearl + Midnight (semantic roles per MDA §5), `font-family` stacks, spacing/radii, motion timing tokens (120–160/200–280/300–400 ms), `prefers-reduced-motion` parity rules.
- Font loading: self-hosted woff2 with `font-display: swap`, Ethiopic subset for Noto Sans Ethiopic.
- Composite primitives seeded first: `<Money>`, `<Countdown>`, `<StatusBadge>`, `<EmptyState>`, `<ErrorState>`, `<ReceiptScreen>`, `<BrandMark>` (per brief §12 + MDA §7).

---

## 3. Implementation Phases

> Each phase lists build items and its completion gate (gates also in §5). Phases are strictly dependency-ordered (§4). Within a phase, build in listed order.

### Phase A — Foundation hardening (design system + shell)

**Build:**
1. Project cleanup: remove template visual scaffolding from Landing/Dashboard/Auth (keep route skeleton + RequireAuth); fix pre-existing lint errors in touched files only.
2. Design tokens/theme system: PULSE oklch tokens, `.dark` Midnight values, theme switcher (persisted), both themes contrast-verified on paper (computed ratios) before preview QA.
3. Typography: Manrope (UI/body), Fraunces (display moments), IBM Plex Mono (codes/financial), Noto Sans Ethiopic (subset) — loaded, `tabular-nums` utility enforced via `<Money>`/`<Countdown>`.
4. `BrandMark` component + favicon set: pulse-descent mark per MDA §7 (variants: mono, light, dark, app icon); final artwork approved by owner in preview.
5. Shared layout primitives: AppShell (top bar, bottom tabs mobile / left rail desktop — identical IA), container widths, sticky action-bar slot.
6. Motion foundation: `motion` package adoption, timing tokens, reduced-motion wrapper.
7. Accessibility foundation: focus-visible ring token, skip link, 44px target conventions, `aria-live` countdown pattern.
8. i18n foundation: keyed dictionary loader, EN+AM message files (structure first; copy filled per feature), `<html lang>` sync, language toggle component.

**Gate (done when):** both themes render one demo screen with correct tokens; fonts load in both languages; motion respects reduced-motion; lint/typecheck pass; no template visual remnants on public shell.

### Phase B — Convex/domain foundation

**Build:**
1. `schema.ts` per Backend Schema: all 17 tables, exact status unions, indexes/uniqueness as specified (incl. unique filtered indexes: phone, providerRef, code, bidRefund.bid, dedupeKey, idempotency keys).
2. Shared domain types (`src/shared/domain.ts` or `convex/pure/types.ts`): money (integer-santim module: parse/format/validate — no floats), status enums (single source), whitelisted projection types.
3. Validation helpers (zod schemas reused by mutations; server recomputation helpers).
4. Guard primitives: `requireUser`, `requireVerifiedPhone`, `requireOperator` (server-side, centralized; role naming per `users.role` until OPEN #12 resolves).
5. Audit + idempotency primitives: `writeAudit(...)` and `withIdempotency(key, op, fn)` helpers enforcing the FROZEN replay semantics; unique-key conflict = return original outcome.
6. Server-only config module for OPEN tunables (absence-aware).
7. Jobs skeleton (cron definitions, sweep entry points) — no business sweeps yet.

**Gate:** `bun convex dev --once` succeeds; schema validation on; a scripted replay of an idempotent stub op double-writes nothing; privacy-boundary unit test asserts projection types contain no prohibited fields.

### Phase C — Identity/authentication

**Build:**
1. **Prerequisite check first (OPEN gate §6.1):** phone-OTP provider mechanism vs do-not-modify auth files — implement as **new provider file** (`auth/phoneOtp.ts`) + platform approval if required; do not modify template auth files without approval.
2. Phone OTP sign-in: request-code + verify mutations (hashed single-use codes, TTL, attempt limits, resend cooldown, uniform responses), SMS send via provider action (provider choice OPEN #13 — adapter behind interface).
3. `phoneVerified` lifecycle; verified-phone gate wired into guard primitive (blocks deposits/bids/withdrawals/settlement).
4. Session handling: RequireAuth + returnTo verified against App Flow §3; anonymous path disabled/never accepted (TRD §4).
5. Profile/display-name/consent mutations (`publicWinnerConsent` default false; no other writer ever).
6. Role enforcement: `requireOperator` applied to all privileged mutation stubs.

**Gate:** unauthenticated → `/auth?returnTo=` → exact restore; unverified phone is blocked from a canary financial mutation with the correct reason class; OTP replay/attempt-limit tests pass; audit rows written for verification events.

### Phase D — Financial core

**Build:**
1. Ledger: `ledgerEntries`/`ledgerPostings` writes with balanced-entry assertion (debits==credits per entry) inside one transaction.
2. Wallets: projection update helper — same-transaction-only writes; read projection for owner.
3. Provenance lots: create-on-deposit, consume-on-debit (lot-selection algorithm — IMPL, FIFO candidate), refund-credit tagging original lots.
4. Economic operations, each `withIdempotency`-wrapped, zero-effect-on-failure: `debitForBidFee`, `creditRefund`, `debitSettlement`, `recordDeposit` (Phase E trigger), `recordWithdrawal` (record-level only).
5. Reconciliation job: journal balance invariant, per-user projection==ledger sums, orphaned confirmations, replay counters → exception outputs (consumed by Phase M).
6. Scenario tests (§7): replay, insufficient funds, partial-lot refunds, wallet races.

**Gate:** every economic op tested for: atomicity (failure = no writes), idempotency (replay = original outcome), provenance correctness (refund re-credits funding lots); reconciliation job runs clean on generated fixture data.

### Phase E — Payments

**Build (adapter-first; provider specifics only after OPEN gates resolve):**
1. `paymentEvents`/`paymentConfirmations` records per schema; status machine initiated→pending→confirmed/failed.
2. Provider adapter boundary: `PaymentProvider` interface (initiate → hosted URL; verify(event) → boolean; parse webhook) — implementations exist only for frozen providers.
3. Chapa adapter (Phase E core): initiate server-side, client receives only hosted URL; webhook HTTP endpoint with signature verification + unguessable path; server-to-server verification before journaling.
4. links.et: **interface stub only** until OPEN #7 scope resolves (`where applicable` — which flows). No flow depends on it.
5. Confirmation → journal → wallet: verified confirmation triggers `recordDeposit` (journal + lot creation + wallet credit + clearing postings) — idempotent by provider ref; replays credit nothing.
6. Server-derived amounts only: client never posts amounts to verification.
7. Deposit exception path: unconfirmed events remain pending; retries with same keys; exhaust → exception view (Phase M consumes).

**Gate (OPEN-gated, §6.7):** adapter + records + journal flow complete against Chapa test/sandbox credentials; duplicate provider event and duplicate verification tests pass; **no live deposit channels are exposed to users until owner freezes channel set** (UI shows deposit entry but final channel list awaits decision; if Chapa credentials are not yet provided, this phase ships adapter + sandbox-flagged integration and gates production use).

### Phase F — Inventory/prizes

**Build:**
1. Prize records (operator CRUD, images, fulfillment method; OPEN fields generic).
2. RESERVE: atomic conditional decrement (`availableCount >= quantity`) + reservation row + audit, in the auction-creation transaction path (used fully in Phase G).
3. COMMIT: settlement-transaction operation (wired in Phase I); RELEASE: void/NO_WINNER/cancel-before-open paths (wired in Phase I/G).
4. Concurrency: serialize losing RESERVE attempts; reservation unique per auction; publish gate check.

**Gate:** concurrency test (parallel RESERVE of last unit) yields exactly one winner-of-race; COMMIT/RELEASE only-from-`reserved` guards tested; no auction can be published without reservation (guard unit test).

### Phase G — Auctions

**Build:**
1. Auction configuration mutation (operator): full field set; OPEN fields written only from config when frozen; `blindMode: true` invariant.
2. Lifecycle mutations: DRAFT→SCHEDULED, SCHEDULED→OPEN (manual open or scheduled sweep), OPEN→CLOSED (sweep + guard in bid mutation), each conditional-state, audit-logged; publish requires reservation (Phase F).
3. Server time authority: all guards use server tx time; client countdown fed by `closeAt` only.
4. Anti-snipe: extension logic inside bid transaction — implemented now, **inactive until OPEN #5 values configured** (window/extend/max read from config; absent = no extension).
5. Finalization: OPEN→CLOSED runs winner determination (pure fn, Phase I exports it) writing `auctionResults` exactly once.
6. Projections (`api/`): catalog, live detail (blind-safe), settled result (frozen field set, consent-gated), operator views.

**Gate:** state-machine test (legal/illegal transitions, concurrent double-transition); projection privacy tests (live blindness, settled field set, consent gating); anti-snipe determinism test with configured values; sweeps idempotent.

### Phase H — Bidding

**Build:**
1. `placeBid` economic mutation per TRD §8: guards (auth, verified phone, OPEN, server time < closeAt incl. extension) → validate amount (bounds from config; **no defaults**) → compute fee (server, from config; absent fee = bidding disabled with honest state) → balance guard → wallet debit (lot consumption) → bid ACCEPTED + audit — one transaction, zero-effect abort on any failure.
2. Blind-bidding enforcement: no aggregate writes; rejection returns reason class only; own-bid projection (amount + status live; +fee/refund post-close).
3. Rate/abuse: throttle counters on bid submission (generic, not a cap; thresholds config).
4. Same-amount rule: validator reads config flag (OPEN #3).
5. Late/boundary behavior: rejection `too_late` with authoritative close time.

**Gate:** adversarial tests pass (§7: close-boundary, wallet race, idempotent replay, duplicate-amount config both ways); zero-effect abort verified by document-count assertions; projections leak nothing (privacy test).

### Phase I — Settlement/refunds

**Build:**
1. Winner determination pure function (min unique amount | NO_WINNER) — exhaustive unit tests first (TRD §26).
2. Finalization wiring in Phase G's OPEN→CLOSED: WINNER → `settlementRecords(pending)` + deadline (config; **no default**) + winner notifications; NO_WINNER → refund engine + RELEASE → SETTLED(NO_WINNER) immediately.
3. `settle` mutation: guards (CLOSED, WINNER, caller=winner, verified, ≤ deadline) → wallet debit (distinct settlement class) → COMMIT → SETTLED(WINNER) + audit; idempotent.
4. Deadline sweep: pending + past deadline → SETTLED(NO_WINNER) + RELEASE + refunds — deterministic, idempotent.
5. Refund engine: per-bid exactly-once wallet credits (provenance-tagged) via `bidRefunds`; shared by NO_WINNER-at-close and void.
6. Settlement-pending visibility: CLOSED+WINNER projection shows result-determined without winner identity; winner sees own pending state (App Flow §6/§12).

**Gate:** exactly-once settlement tests (concurrent settle calls, settle-after-void, double finalization); refund determinism (every accepted bid refunded exactly once incl. defaulting winner; none on WINNER); inventory COMMIT/RELEASE observed in same transactions; CLOSED≠SETTLED invariant asserted.

### Phase J — Fulfillment

**Build:**
1. Fulfillment record creation on SETTLED(WINNER); status vocabulary per schema.
2. Delivery: address submission mutation (owner-only, validated); pickup: instructions view + verification code issuance/confirmation.
3. Status progression mutations (operator): PENDING→…→COMPLETED (proof reference; artifact format OPEN #11 — generic ref) | FAILED/UNRESOLVED; each transition audit + notification event (Phase K).
4. Owner projection incl. own address; operator projection for queues.

**Gate:** status transitions legal-only; address data owner+operator-only (privacy test); completion requires proof reference; SMS/in-app events emitted exactly once per transition.

### Phase K — Notifications

**Build:**
1. Notification record writer with `(event, recipient, channel)` dedupe; in-app rows queryable by owner.
2. SMS send action behind provider adapter (OPEN #13); retry-with-same-key; FAILED after exhaustion → operator-visible.
3. Critical events wired: winner notification, settlement deadline/reminders, settlement failed/NO_WINNER, fulfillment updates, refund completed; deep-link payloads.
4. Send-once guarantee: side-effect ordering per TRD §21 (money truth never depends on send success).

**Gate:** duplicate event injection produces one record + one send; retry exhaustion lands in exceptions view; EN+AM bodies resolved from keys; no email channel anywhere.

### Phase L — Consumer UI (App Flow order)

**Build (each step = its own focused task):**
1. **Landing** (`/`): PULSE hero, how-it-works diagram, featured/live/upcoming/settled preview, CTAs into `/auth`/`/auctions`; EN/AM + theme toggles.
2. **Sign-in** (`/auth`): phone → OTP → name steps (MDA §8); brand stage; both themes.
3. **Onboarding/profile**: name, consent toggle, language/theme; verified-phone badge.
4. **Marketplace** (`/auctions`): Featured→Live→Upcoming→Settled tabs, cards per MDA §9; blind-safe fields only.
5. **Auction detail**: state-driven branches (SCHEDULED/OPEN/CLOSED-pending/NO_WINNER/SETTLED); hierarchy per MDA §10; rules + mechanic diagram.
6. **Bidding**: BidPanel state machine (idle/submitting/accepted/rejected-reason/ended/needs-topup/not-verified/not-open/not-configured); sticky mobile panel; anti-snipe countdown re-extension UX; insufficient-balance → deposit preserving intent.
7. **Wallet**: balance hero, deposit flow (hosted checkout → confirming → receipt), withdrawal honest state, history + reference detail.
8. **Transactions** detail; **Settlement** screen (deadline countdown, exact-debit confirm, top-up gap, voided terminal state); **Results** (frozen projection, consent-gated, NO_WINNER explainer, own-bids self-view); **Fulfillment** (address form / pickup + timeline); **Notifications**; **Profile/settings**.
9. Global states per App Flow §18; PULSE motion per §13 of MDA; every money surface uses `<Money>`/`<ReceiptScreen>`; loading = spinners (no skeletons).

**Gate (per major step + overall):** App Flow §1 global rules hold (spot-checked); all L screens pass §8 visual QA checklist at 375/430/768/1280, both themes, both languages, reduced motion, keyboard-only pass; no blind-bidding copy violations (audit against MDA/brief anti-patterns).

### Phase M — Operator/Admin ("LUBA Operations")

**Build (queue-first, MDA §12):**
1. Operations shell + queue dashboard (live auctions, settlement, payment exceptions, financial/reconciliation, fulfillment, withdrawals, notifications/audit) — counts + drill-ins.
2. Auction create/configure stepper (prize → RESERVE confirmation → timing/anti-snipe-if-configured → economics-if-configured → fulfillment → review → publish); open/cancel-before-open actions.
3. Inventory screens (counts, reservation history, low stock).
4. Settlement queue (pending deadlines, reminder status, void determinism visibility); payment exceptions (retry/check-status/resolve-with-audit-note); financial exceptions (reconciliation outputs).
5. Fulfillment queue (status updates, proof attach); withdrawals queue (record-level until OPEN #8 resolves); users lookup (minimal); audit browser.
6. Consequence-stating confirmations on money-touching actions; operator attribution on every action.

**Gate:** every queue backed by real records (no fake data); privileged routes reject non-operators server-side; destructive actions require consequence dialogs; audit rows attributed for all operator actions in tests.

### Phase N — Verification/hardening

**Build:**
1. Full §7 test matrix green; adversarial scenarios executed against dev deployment.
2. Accessibility audit: keyboard-only journeys, focus order, reduced motion, countdown announcements, contrast re-verification both themes.
3. Responsive QA per §8 (evidence-based).
4. Security review per §9 checklist.
5. Financial reconciliation dry-run: generate fixture economy (deposits→bids→closes→settlements/voids→refunds), run reconciliation job, assert zero exceptions; then replay-damage fixtures and assert detection.
6. Failure/retry drills: kill webhook mid-flight, replay provider events, exhaust SMS retries, force deadline void — assert convergent, idempotent outcomes.
7. Docs sync: Implementation Plan gates cross-checked against delivered code.

**Gate:** this phase's checklist is the release checklist; production promotion only when all boxes are evidenced (not claimed).

---

## 4. Dependency Graph

```
A Foundation ──► B Convex/domain ──► C Identity ──► D Financial core ──► E Payments
                        │                                │
                        ├──► F Inventory ──► G Auctions ──► H Bidding ──► I Settlement/refunds ──► J Fulfillment
                        │                                    │                                     │
                        └────────── K Notifications ◄────────┴─────────────────────────────────────┘
                                                                        │
                                        L Consumer UI ◄─────────────────┘  (consumes C–K projections)
                                        M Operator ◄── F, G, I, E-excepts, K
                                        N Verification ◄── all
```

**Hard edges (nothing downstream starts before upstream gate passes):**
- Auth → wallet → bidding → settlement → fulfillment (financial spine).
- Inventory RESERVE → auction publish → bidding.
- Auction close → winner determination → settlement → refunds → fulfillment.
- Ledger/wallet (D) → every economic consumer (E, H, I).
- Payments confirmation (E) → wallet credits → bidding with real balance.
- Projections (G) → consumer UI (L) and operator (M).
- Notifications (K) → settlement/fulfillment UX completeness (winner awareness is a TRD risk control).
- No phase depends on an OPEN decision except through a config abstraction (§6).

**No circular dependencies:** UI phases consume only existing projections; operator queue for payments consumes only Phase E record states; nothing later writes into earlier phases' contracts except through declared mutations.

---

## 5. Per-Phase Completion Gates (summary table)

Every phase's "done when" (details inline above). Universal gate items for **every** phase: typecheck passes; lint clean on new code; no unrelated files touched; no OPEN value invented; audit/idempotency discipline intact where applicable.

| Phase | Gate emphasizes |
|---|---|
| A | Tokens complete both themes; fonts EN+AM; reduced-motion parity; shell a11y; no template remnants |
| B | Schema validates; unique indexes live; replay no-op proven; projections typed safe |
| C | returnTo restore; verified-phone gate blocks canary financial op; OTP limits tested; audit written |
| D | Atomicity + idempotency + provenance tests green; reconciliation clean on fixtures |
| E | Verified-before-journaling proven; duplicate provider event = zero credit; **production use blocked pending OPEN #7 freeze** |
| F | RESERVE race → exactly one; publish impossible without reservation |
| G | State machine legal-only; projections privacy-tested; anti-snipe deterministic when configured |
| H | Zero-effect aborts proven; blind-bidding leak tests green; boundary/race tests green |
| I | Exactly-once settlement; refunds exactly-once; CLOSED≠SETTLED invariant; COMMIT/RELEASE in-transaction |
| J | Legal-only transitions; owner-only address; proof required at completion |
| K | Dedupe unique-key proven; retry exhaustion visible; no email channel |
| L | Visual QA §8 evidenced; App Flow global rules hold; no anti-pattern copy |
| M | Server-side privilege rejection; consequence confirmations; attributed audit |
| N | Full matrix green; reconciliation detects injected damage; release checklist evidenced |

---

## 6. OPEN Decision Gates

| # | Decision (source) | Blocks | Proceed with abstraction/config placeholder? | Must be decided before… |
|---|---|---|---|---|
| 1 | Phone-OTP provider mechanism vs do-not-modify auth files (TRD OQ1) | Phase C entirely | **No** — needs platform approval path chosen first (new provider file is the default approach) | Any sign-in implementation |
| 2 | SMS provider (TRD OQ2 / OQ13) | OTP send (C), SMS channel (K) | **Yes** — SMSAdapter interface + no-op/dev transport; real provider later | Production OTP/notifications |
| 3 | Bid-fee model + amount (PRD Q17) | Fee display (L), fee charging in `placeBid` (H) | **Yes** — server fee module reads config; absent ⇒ bidding surface shows honest "not configured" and mutations refuse fee ops | **Production bidding** (paid-bid product cannot launch without it) |
| 4 | Min/max bid bounds (PRD Q5) | Validation (H), UI hints | **Yes** — config absent ⇒ no bounds enforced beyond amount validity; UI omits hints | Production (recommended) |
| 5 | Same-amount repeat rule (PRD Q5) | Bid validator (H) | **Yes** — config flag defaulting to "allowed" (permissive, no invented prohibition) — but flag semantics confirmed by owner before production | Production |
| 6 | Per-user bid-volume cap (PRD Q6) | Nothing in V1 build (throttle ≠ cap) | **Yes** — n/a; only generic anti-abuse throttles | n/a (may remain open) |
| 7 | Anti-snipe window/extend/max (PRD Q7) | Extension activity (G), countdown UX edge (L) | **Yes** — logic built, inactive while unset; countdown shows fixed close | Production (else fixed-close behavior — acceptable but confirm) |
| 8 | Settlement deadline duration (PRD Q13) | `settlementRecords.deadline` (I), winner UX | **No** — settlement cannot be armed without a deadline; ship code, block enabling | **Production settlement** |
| 9 | Chapa deposit channels; webhook config (TRD OQ3) | Live deposit channels (E), operator exceptions detail | **Yes** — adapter + records + sandbox integration; user-facing channel list renders only configured channels | **Production deposits** |
| 10 | links.et scope (TRD OQ4) | Receipt-verification flows (E) | **Yes** — interface stub only; no flow depends on it | Production (only if owner wants the flow) |
| 11 | Withdrawal parameters + payout mechanism (PRD Q14 / TRD OQ8) | Withdrawal UX (L), withdrawal queue (M) | **Yes** — record model + honest "being finalized" UI; no payout mechanics built | **Production withdrawals** |
| 12 | KYC depth (PRD Q19) | Nothing structural (users table extensible) | **Yes** — verified-phone only, as frozen | Production (legal review is owner's) |
| 13 | Live accepted-bid counter (TRD OQ5) | Catalog/detail display | **Yes** — default OFF; no counter fields exist (schema) | Production display decision |
| 14 | Proof-of-fulfillment format (TRD OQ7) | Proof attachment UX (J/M) | **Yes** — generic reference field | Production (only affects artifact form) |
| 15 | Operator role naming/hierarchy (TRD OQ9) | `requireOperator` (B/C/M) | **Yes** — single `role: "operator"` until refined | Production (if tiers wanted) |
| 16 | Inventory multi-auction backing (TRD OQ6) | Reservation model nuance (F) | **Yes** — dedicated line per auction (default) | Production (only if owner wants sharing) |
| 17 | Fulfillment geography/pricing/locations (PRD Q11) | Pickup details, delivery copy (J/L/M) | **Yes** — generic operator-configured fields | Production fulfillment |

**Rule:** a phase may *ship code* through a placeholder; it may not *enable the dependent user-facing behavior in production* until the owning decision freezes. Nothing above is treated as silently configured.

---

## 7. Testing Strategy (mapped to phases; adversarial scenarios required)

| Test layer | Phase | Required scenarios |
|---|---|---|
| Pure unit (Vitest) | B, G, H, I | santim parse/format; winner determination (no bids / single / all-duplicated / multiple-unique / duplicate-low edge); fee math (once frozen); lot allocation (partial consumption, refund re-credit); anti-snipe determinism + max-bound |
| Economic scenario | D, E, H, I, K | **concurrent idempotency** (parallel same-key ops → one effect, one outcome); **wallet races** (parallel debits ≤ balance → sum never negative, losers rejected zero-effect); replay safety on every op; partial-failure atomicity |
| State machine | F, G, I | illegal transitions rejected; concurrent double-transition; **inventory races** (parallel RESERVE of last unit; RESERVE vs cancel); publish-without-reservation blocked |
| Boundary/adversarial | G, H, I | **close-boundary bids** (bid at t=closeAt−1, t=closeAt, t=closeAt+anti-snipe-adjusted); **settlement races** (parallel settle + deadline sweep → exactly one outcome); settle-after-void; double finalization |
| Payments adversarial | E | **duplicate provider events** (same ref twice → credit once); **duplicate verification** (webhook + hosted-return → journal once); signature-invalid events rejected; retry with same key converges |
| Withdrawal adversarial | D/E-adjacent | **withdrawal races** (request vs bid vs settle on same balance → no double-spend; in-flight semantics per chosen IMPL when frozen); **retry safety** on payout confirmation |
| Notification | K | duplicate event → one record/one send; retry exhaustion → exceptions view |
| Privacy | B, G, H, I, J | projection whitelist asserts: live blindness (no distribution/uniqueness/ranking fields reachable), settled field set exact, consent gating, owner-only wallet/bids/notifications/fulfillment |
| Reconciliation | D, N | balanced-journal invariant; projection==ledger sums; injected damage detected |

**Constraint:** no browser automation in-repo (platform capability); E2E confidence comes from §8 owner verification + the scenario matrix above.

---

## 8. Visual QA Strategy (evidence-based)

Because reliable in-repo browser/screenshot tooling does not exist in this environment, **visual QA is never claimed without evidence** — the owner (or Playwright if later available) performs it against exact checklists.

**Per checklist item, evidence = route + viewport + theme + language + observed result reported back in writing (and screenshots if the platform provides them).**

### Routes to verify (consumer)
`/` · `/auth` · `/auctions` · `/auctions/:id` (all five states: SCHEDULED, OPEN, CLOSED-pending, NO_WINNER, SETTLED) · `/dashboard` · `/wallet` · `/wallet/deposit` (confirming + receipt states) · `/wallet/history` · `/bids` · `/settlement/:id` (pending, paid, voided) · `/fulfillment/:id` (delivery + pickup) · `/notifications` · `/profile`.

### Routes to verify (operator)
`/operations` (queues) · auction create stepper · inventory · settlement/payment/financial exception queues · fulfillment queue · audit view.

### Matrix per route
- **Viewports:** 375 · 430 · 768 · 1280 (QA-primary per MDA §17).
- **Themes:** Pearl + Midnight — every route, both.
- **Languages:** EN + AM — every route, both (watch text expansion, Ethiopic line-height, no truncation of money/deadline copy).
- **States:** loading (spinner), empty, error, success/receipt per App Flow §18.
- **Interaction:** keyboard-only pass (focus order, Escape, skip link); reduced-motion pass; focus-visible rings.
- **Specific checks:** sticky bid panel within thumb reach at 375/430; countdown tabular-nums (no reflow); anti-snipe re-extension UX; consent-gated winner name; NO_WINNER explainer; receipt screens after every money action; both themes on brand stage (auth) and winner reveal (gold).

**Rule for the implementer:** after each Phase L/M step, hand the owner the exact checklist rows for what changed; integrate reported defects before the next step. Never report "looks good" without the owner's evidence.

---

## 9. Security Implementation Gates

| Gate | Requirement (all FROZEN/IMPL per TRD §5/§7/§19/§20/§27/§28) |
|---|---|
| Secret handling | Secrets only in platform env vars, read in `"use node"` actions; never client-side, never in responses/logs; `.env` never edited |
| Client/server boundary | Client is untrusted UI: no client amounts/fees/prices/statuses/times trusted; server recomputes all |
| Privileged mutations | `requireOperator` on every operator mutation; regular users structurally cannot invoke privileged paths; role hierarchy per OPEN #15 |
| Public projections | Whitelist-only query shapes; prohibited fields structurally absent (privacy tests in CI); blind-bidding structural guarantee (§15.4 of schema) |
| Payment amount authority | Amounts verified server-to-server from provider artifacts; client-claimed success never journals; provider-ref uniqueness |
| Receipt credential handling | Reference/idempotency codes shown to users are non-enumerable, owner-scoped in detail views; OTP hashed at rest, single-use, attempt-limited, uniform errors |
| Webhook endpoints | Signature verification, unguessable paths, idempotent ingestion; no state change from unverified events |
| Audit logging | Every economic op, lifecycle transition, inventory op, anti-snipe extension, privileged action, notification send — same-transaction audit rows, attributed, PII-minimized |
| Error sanitization | Deterministic reason classes only; no internals/stack/provider payloads to client; no enumeration via error text |
| Session boundaries | Anonymous path disabled/never accepted; verified-phone gate on all financial ops |

Each gate is checked in the phase that introduces the surface (C, E, G–K, M) and re-audited in Phase N.

---

## 10. Migration / Rollback Discipline

- **Greenfield:** no legacy business data exists; **no migration of business data** unless the owner explicitly requires it later (template users table aside — leave template auth rows untouched).
- **Independently verifiable phases:** each phase ends shippable (compiles, typechecks, gates pass) even if later phases are absent; no phase relies on unreleased siblings at runtime.
- **Reversible changes preferred:** additive schema fields/tables first; destructive schema changes avoided in V1 (no migrations system needed per TRD §27); config-module changes trivially revertible.
- **No bundling:** one task = one change set; a defect fix never rides along with a feature; Convex pushes per touched-phase (`bun convex dev --once`) so function changes stay reviewable.
- **Rollback posture:** UI phases roll back by revert (no data effects); economic phases roll back by disabling the mutation entry points (config flags) — data written by tested idempotent transactions remains consistent (ledger truth).

---

## 11. Prompting Strategy for Future Freebuff Work

Each future implementation prompt/turn must follow this pattern:

1. **One focused task at a time.** Example: "Implement `placeBid` economic mutation per TRD §8 + Backend Schema §9, with its scenario tests." Never "build the bidding system."
2. **Explicit files/scope.** Name the files to create/modify (e.g., `src/convex/economic/bids.ts`, `src/convex/pure/winner.ts`, `src/convex/schema.ts` additions) and name what must **not** be touched (auth template files, `vite.config.ts` HMR, `_generated`).
3. **Explicit constraints.** Cite the governing docs and sections (TRD §8, Schema §9, App Flow §7); restate the relevant FROZEN invariants in the prompt; restate any OPEN gate that applies (e.g., "fee config absent ⇒ bidding disabled state").
4. **Explicit completion checks.** Define the gate: `bun convex dev --once` (if schema/functions touched) → `bun tsc -b --noEmit` → new tests written and passing → specific behavioral assertions listed → privacy/idempotency checks named.
5. **No broad "build everything" prompts.** Phases are split into tasks the size of one reviewable change; Phase L UI steps are one screen or component cluster per task.
6. **Implement → audit/verify loop.** After each task, run a verification pass (tests + typecheck + a privacy/idempotency spot-audit + App Flow rule check) *before* declaring done; visual hand-off per §8 checklist for UI tasks.
7. **Prompt template:**
   > **Task:** <one sentence>. **Scope:** files in/out. **Authority:** doc §refs + frozen invariants. **OPEN gates:** applicable ones. **Done when:** checks 1–n. **Do not:** touch X, invent Y, bundle Z.

---

## 12. Final Implementation Order

1. **Foundation hardening (A):** cleanup, PULSE tokens/themes, typography, BrandMark, shell primitives, motion, a11y, i18n skeleton.
2. **Convex/domain foundation (B):** full schema, domain types, money module, guards, audit/idempotency primitives, config module, jobs skeleton.
3. **Identity (C):** phone OTP provider (post platform-approval path), verified-phone gate, sessions/returnTo, profile/consent, role enforcement.
4. **Financial core (D):** ledger/postings/wallets/provenance lots + economic op primitives + reconciliation job.
5. **Payments (E):** records, adapter boundary, Chapa sandbox integration, confirmation→journal→wallet; links.et stub.
6. **Inventory (F):** prizes + RESERVE/COMMIT/RELEASE with race safety.
7. **Auctions (G):** configuration, lifecycle, scheduling/open/close sweeps, server time, anti-snipe (inactive until configured), finalization + projections.
8. **Bidding (H):** placeBid transaction, blind enforcement, balance/fee/bounds via config, throttles.
9. **Settlement/refunds (I):** winner determination, settlement-pending, settle, deadline void, refund engine, inventory commit/release wiring.
10. **Fulfillment (J):** delivery/pickup records, address/pickup flows, proof, status progression.
11. **Notifications (K):** dedupe records, in-app, SMS adapter, critical events.
12. **Consumer UI (L):** landing → sign-in → onboarding → marketplace → auction detail → bidding → wallet → transactions → settlement → results → fulfillment → notifications → profile (each step visual-QA'd per §8).
13. **Operator console (M):** queues, auction creation stepper, inventory, exception queues, fulfillment, withdrawals (record-level), audit.
14. **Verification/hardening (N):** full test matrix, a11y, responsive/visual evidence, security review, reconciliation dry-run, failure/retry drills — release checklist.

*(Within 12: screens ship in App Flow order, each with its visual-QA hand-off. Phases 1–11 are backend-capability phases consumed by 12–13; 14 gates production.)*

---

*End of Implementation Plan (v1.0). No code written; no implementation files modified — planning artifact only.*
