# LUBA — V1 App Flow

**Document status:** FINAL (v1.0). Complete user and operator navigation/interaction flow for LUBA V1.
**Basis (authoritative, in order):** Approved PRD (product authority) · `docs/luba-v1-trd.md` (technical authority) · `docs/luba-master-design-authority.md` (visual/interaction authority — LUBA PULSE) · `docs/luba-v1-ui-ux-design-brief.md` (behavioral UX authority; visual sections superseded by the Master Design Authority).
**Out of scope:** database/schema design (Backend Schema document), implementation task breakdown (Implementation Plan).
**Conventions:** `[OPEN]` = undecided upstream decision — never assumed, UI admits only what is configured. All amounts are integer santims displayed via the shared `ETB X.XX` formatter. All decisions (close, deadline, acceptance, money) are **server-authoritative**; client countdowns are display-only. Every flow below respects the frozen blind-bidding law: no live distribution, no uniqueness feedback, no lowest-unique reveal, no ranking — only the approved post-close public projection.

**Route map (used throughout):**

| Route | Access |
|---|---|
| `/` | Public — landing |
| `/auctions` | Public — marketplace catalog |
| `/auctions/:id` | Public — auction detail (bid panel gated) |
| `/auctions/:id/result` | Public — settled result view |
| `/auth` | Public — phone OTP sign-in |
| `/dashboard` | Protected — bidding cockpit |
| `/auctions/:id/bid` context | Protected — auction detail (bid view) |
| `/wallet` | Protected — wallet |
| `/wallet/deposit` | Protected — deposit flow |
| `/wallet/history` | Protected — transaction history |
| `/bids` | Protected — my bids |
| `/settlement/:auctionId` | Protected — winner settlement |
| `/fulfillment/:auctionId` | Protected — fulfillment |
| `/notifications` | Protected — in-app notifications |
| `/profile` | Protected — profile/settings |
| `/operations/…` | Operator-gated — LUBA Operations console |

---

## 1. Global Rules (apply to every flow)

- **Server authority:** countdowns, deadline checks, bid acceptance, fee computation, balances — all decided server-side. The client renders states; it never decides them. A client clock (or stale subscription) can never produce a successful money action.
- **Honest transactional status:** every money action resolves to exactly one visible state — accepted / rejected (reason class) / pending (with provider truth). No optimistic success, no fake latency.
- **Blind-bidding law:** live auction surfaces show only prize info, state, countdown, configured economics, fulfillment chip, and the user's *own* transactional statuses. Violations in copy (e.g., "you're currently winning") are defects.
- **Idempotent actions:** every economic action carries an idempotency key; double-tap/retry is always safe; replays return the original outcome.
- **Bilingual:** every screen and every state string exists in EN and AM; `lang` attribute follows the toggle; no truncation of financial or deadline copy.
- **Both themes:** every screen is designed and QA'd in Pearl (light) and Midnight (dark), per the Master Design Authority.
- **OPEN-parameter discipline:** fee, bounds, bid-volume rules, anti-snipe values, settlement deadline, withdrawal parameters, live counter — rendered only when configured; UI never invents defaults.

---

## 2. Public / Marketing Flow

- **Entry point:** `/` (landing), or any deep link.
- **User actions & destinations:**
  1. Read hero ("The lowest unique bid wins.") + how-it-works diagram (bids descend → duplicates eliminate → lowest unique point wins).
  2. View live auction previews → **Featured auction → Live auctions → Upcoming → Settled history** priority order (PULSE marketplace hierarchy).
  3. Tap any auction card → `/auctions/:id`.
  4. Tap primary CTA ("Start bidding") → `/auth?returnTo=/auctions` (or the auction they came from).
  5. Already signed in → primary CTA becomes "Dashboard" → `/dashboard`.
  6. Language toggle EN/አማ → instant, persisted; theme toggle → Pearl/Midnight, persisted.
- **System state shown:** public projections only — catalog cards (imagery, LIVE/UPCOMING/SETTLED badge, countdown for live, fee line only when configured, auction code in mono, bid CTA), settled result chips with winning amounts.
- **Success outcome:** visitor reaches either an auction detail (browse path) or `/auth` (participation path).
- **Failure/exception:** none specific; empty catalog renders the §18 empty state ("No live auctions right now — see what's coming up" → Upcoming tab).

## 3. Phone OTP Sign-In Flow

- **Entry point:** any protected action (bid, deposit, settle, dashboard) via `RequireAuth` → `/auth?returnTo=<original path>`; or direct navigation.
- **Step 1 — Phone:**
  - User action: enter phone number → tap "Continue."
  - System state: large single input, ET/Ethiopia context, submit pending state.
  - Success → Step 2. Failure → inline reason (invalid format, too many requests — uniform response, no phone enumeration); cooldown countdown on resend.
- **Step 2 — OTP:**
  - User action: enter 6-digit code (mono segmented input, auto-advance, paste support) → "Verify."
  - System state: "Sending code" then verification state; resend with honest countdown.
  - Success → `phoneVerified` set server-side → destination resolution (below). Failure → inline "Incorrect or expired code" with retry; repeated failure → attempt-limit message + resend path.
- **First-time only — Step 3:** display-name step (one field) → then destination resolution.
- **Destination resolution (success):** navigate to `returnTo` if present and safe (internal path only); otherwise `/dashboard`. Never back to `/` for an authenticated product.
- **Session boundaries (frozen):** anonymous sign-in is disabled and its token path never accepted; email is optional profile data, not a sign-in method; no social/linked logins in V1. Verified phone is required before **any** financial action (bid, deposit, withdraw, settlement) — unverified states block with a clear path, never silently.
- **Failure/exception:** SMS delivery failure → honest "We couldn't send the code — try again" + retry; OTP TTL expiry → resend.

## 4. Onboarding / Profile Flow

- **Entry point:** post-first-sign-in (display-name step above); later via `/profile`.
- **User actions:** set/edit display name (this is also `publicDisplayName`); optional email; **public winner consent toggle** (default OFF, explicit copy: "Show your display name on auctions you win. Winning never turns this on automatically."); language switch; theme preference; sign out.
- **System state shown:** phone with verified badge (read-only in V1), consent state, language/theme state.
- **Success:** profile saved (toast-level confirmation); consent change reflected in future settled results only.
- **Failure/exception:** save failure → inline retry; no partial-consent states (toggle is atomic).

## 5. Marketplace Browsing Flow

- **Entry point:** `/auctions` (tab from bottom bar / rail), or landing featured CTA.
- **User actions:** switch priority tabs **Featured → Live → Upcoming → Settled**; filter chips (status, fulfillment method); search; tap card.
- **System state shown:** auction cards per §9 of the Master Design Authority — imagery, state badge (icon + text, never color alone), countdown (live), start time (upcoming), result chip + winning amount (settled), fee line only when configured, auction code.
- **Next destination:** `/auctions/:id`.
- **Success:** user lands on auction detail in its current state.
- **Failure/exception:** fetch error → §18 error state with retry; empty tab → §18 empty state with one action.

## 6. Auction Detail Flow (state-driven branches)

- **Entry point:** `/auctions/:id` from catalog, dashboard, notification, or deep link.
- **State branches (server projection decides what renders):**

| Auction state | What renders | Primary action |
|---|---|---|
| SCHEDULED | Prize, starts-at time, rules, "Remind me" (in-app intent) | None — honest "Opens <time>" |
| OPEN | Prize, LIVE badge, countdown, economics, rules, own-bid block (if signed in), **bid panel** | Place bid (gated) |
| CLOSED (result WINNER, settlement pending) | Result-determined notice, no winner identity published yet; winner sees settlement alert + CTA | Winner: "Pay ETB X.XX"; others: "Result pending settlement" |
| CLOSED (NO_WINNER resolved → SETTLED immediately per TRD §11) | Public result: NO_WINNER + refund explainer | "View your refunds" (participants) |
| SETTLED (WINNER) | Public result block per frozen projection: result, winning amount, close time, final accepted-bid count, prize, winner display name **only if consented** (else "Winner chose to stay anonymous") | Fulfillment status (winner) |

- **Hierarchy (PULSE, frozen order):** product → live state → countdown → economics → bid control → rules → own bid state → auction information.
- **Success:** user sees a truthful state and the one correct next action.
- **Failure/exception:** unknown id → NotFound; fetch error → retry state.

## 7. Blind Bidding Flow

- **Entry point:** auction detail (OPEN), signed in **and** phone-verified.
- **Gates before the panel is active:** not signed in → "Sign in to bid" → `/auth?returnTo=/auctions/:id`; signed in, phone unverified → verify-phone step; auction not OPEN → state branch (§6).
- **User action:** enter amount (numeric keypad-friendly; parsed to integer santims by the shared parser) → review fee line ("Bid fee: ETB X.XX · You pay: ETB X.XX" — rendered only when fee is configured `[OPEN]`) → tap **Place bid**.
- **System transaction (TRD §8, one atomic mutation):** guards (auth, verified phone, state OPEN, server time < authoritative closeTime incl. anti-snipe adjustments) → amount validation (bounds `[OPEN]`, logic frozen) → server fee computation (`[OPEN]`) → balance guard → wallet debit (ledger + projection + provenance lot consumption) → bid record ACCEPTED → audit. Any failure aborts with **zero economic effect**.
- **Anti-snipe behavior:** if server time is inside the trigger window (`[OPEN]` parameters), the same transaction extends `closeTime` deterministically (bounded `[OPEN]`); all clients' countdowns re-render with a one-time subtle pulse + "Extended — bidding continues." No public CLOSING state ever exists.
- **Success outcome (ACCEPTED):** inline status "Bid accepted" + new row appended in own-bids block (own amount + status only). No uniqueness, ranking, or comparative feedback of any kind.
- **Failure outcomes (REJECTED, reason class only):**
  - *Insufficient balance* → panel switches to "Top up to bid" state → deposit flow (§10) with the intended amount preserved on return.
  - *Bidding has ended* → honest rejection with the authoritative close time; no client-side pretending.
  - *Out of range* → inline bounds message (when bounds are configured).
  - *Same-amount rule* → only if the duplicate-amount rule `[OPEN]` is configured to block; otherwise not shown.
  - *Too many requests* → throttle message (generic anti-abuse, never a bid-count cap `[OPEN]`).
- **Countdown:** display-only from server `closeTime`; tabular numerals; ending-soon treatment per interaction-state matrix; no per-second assistive-tech announcements (throttled at boundaries).
- **Blind-bidding guarantee across the whole flow:** the only bid information the user ever receives live is **their own** transactional status.

## 8. Bid Success / Rejection States (summary matrix)

| Outcome | User sees | Money effect | Next destination |
|---|---|---|---|
| Accepted | "Bid accepted" + own-bids row | Fee debited (server-computed) | Stays on auction; may continue bidding |
| Insufficient balance | Rejection + "Top up to bid" | **None** (zero-effect abort) | Deposit flow, amount preserved |
| Too late | Rejection + authoritative close time | **None** | Result view when published |
| Out of range | Inline bounds error | **None** | Stays; correct input |
| Throttled | Retry-later message | **None** | Stays |

## 9. Wallet Flow

- **Entry point:** bottom tab "Wallet" / rail item; or from any insufficient-balance / settlement top-up path.
- **User actions:** view balance hero (tabular, server truth, "Updated just now"); tap **Deposit** (primary); tap **Withdraw** (secondary — honest "Withdrawals are being finalized" state while PRD parameters `[OPEN]`; never hidden, never a fake form); open **Transaction history** (`/wallet/history`).
- **System state shown:** balance (wallet projection, reconciled against ledger), recent money movement rows (Deposit / Bid fee / Refund / Settlement / Withdrawal; signed amounts; status badges Pending/Completed/Failed).
- **Success:** balance and history reflect ledger truth via subscription.
- **Failure/exception:** projection/ledger mismatch is an operator exception (reconciliation), not a user-facing state; fetch error → retry.

## 10. Deposit / Payment Flow (Chapa hosted; links.et verification where applicable `[OPEN]`)

- **Entry point:** Wallet → Deposit; or "Top up to bid" from a rejected bid; or settlement "Top up."
- **User action:** enter amount (preset chips + custom, integer-santim parsing) → confirm → Chapa **hosted checkout** (client receives only the hosted URL per TRD §7).
- **System states:**
  1. Redirect to provider-hosted payment.
  2. Return → **"Confirming your payment"** pending screen — honest copy; balance updates automatically on confirmation.
  3. Server verifies provider event server-to-server (and/or receipt/reference via links.et where applicable `[OPEN]`) → **only then** journals the deposit and credits the wallet (idempotent by provider reference; replays credit nothing).
- **Success outcome:** wallet-credit lands via subscription → success receipt (amount, reference code, next step) → back to origin (auction bid intent preserved if applicable).
- **Failure/exception:**
  - User abandons checkout → pending state persists with "Check status" + "Try another method"; **never** optimistically credited.
  - Provider event unconfirmed → stays pending; unresolvable after retries → operator payment-exceptions queue; user keeps "Check status."
  - Never show "failed" unless the ledger says so.

## 11. Transaction History Flow

- **Entry point:** `/wallet/history` from wallet.
- **User actions:** scroll grouped-by-day list; tap row → detail sheet with **idempotency/reference code** (support/disputes anchor).
- **System state shown:** every economic event affecting the user — deposits, bid fees, refunds, settlements, withdrawals — signed, statused, with provenance-preserving labels; no ledger internals, no other users.
- **Success:** complete, reconciled self-view.
- **Failure/exception:** fetch error → retry; empty → §18 empty state.

## 12. Settlement Flow — WINNER

- **Entry points:** win notification (SMS + in-app, deep link) → `/settlement/:auctionId`; persistent dashboard/alert entries; auction detail branch (§6).
- **State model (frozen):** auction is **CLOSED with settlement pending** from result determination until payment or deadline — never shown as SETTLED prematurely.
- **Choreography:**
  1. **Win moment:** result screen (prize, winning amount, **settlement deadline countdown**, gold/winner emphasis). Consequence stated unmissably: "Pay by <deadline> or the auction is voided and all bids are refunded."
  2. **Pending window:** persistent recurrent alert (dashboard + auction page); SMS deadline reminders mirror the same copy (frozen channel).
  3. **Payment:** if balance ≥ winning amount → one confirm step showing exact debit ("Wallet: ETB A → ETB A−X") → **settle mutation (TRD §11 Phase 2a):** one transaction — wallet debit (distinct settlement ledger class) → inventory **COMMIT** → auction → SETTLED(WINNER) → audit. Idempotent; double-tap safe.
  4. **If insufficient balance:** explicit gap ("You need ETB Y more") + **Top up** → deposit flow (§10) → return to settlement; top-up is possible any time before the deadline (`[OPEN]` duration).
- **Success outcome:** SETTLED(WINNER) → receipt → fulfillment flow (§15) starts (delivery address or pickup instructions).
- **Failure/exception:** deadline lapses without payment → **Phase 2b (frozen void-and-refund):** deterministic transition to SETTLED(NO_WINNER), inventory **RELEASE**, full bid-fee refunds to wallets (including the defaulting winner's own fees — settlement obligation is separate from fees). The former winner sees a respectful terminal state ("Settlement window closed — the auction ended with no winner. Your bid fees have been refunded to your wallet.") + refund rows in wallet. No blame, no re-award, no runner-up.

## 13. NO_WINNER / Refund Flow

- **Entry point:** auction close with no unique bid (every amount bid ≥ twice) — settlement is never opened.
- **Flow:** close → finalization determines NO_WINNER → shared refund engine runs once per accepted bid (wallet credit tagged with the bid's original provenance lots; bid marked refunded; per-bid idempotency — no duplicate credits) → inventory **RELEASE** → auction → SETTLED(NO_WINNER).
- **User experience:** public result explains plainly: "Every amount was bid more than once, so there is no winner. All bid fees have been refunded." Participants see refund rows in wallet history and refund status on their own bids; refund-destination is the **LUBA wallet** (frozen), never an automatic external refund.
- **Success:** every participant's fees refunded exactly once; one deterministic terminal result.
- **Failure/exception:** refund engine retries are idempotent; any anomaly → reconciliation/financial-exceptions queue (operator).

## 14. Own-Bids / Results Visibility Flow

- **Entry point:** `/bids` (My bids) or auction detail own-bid block.
- **Live (auction OPEN):** own amounts + transactional status only. Never uniqueness, duplication, ranking, or other bids — even privately.
- **Post-close:** own amounts + per-bid fee + refund status (frozen self-view B). Quiet helper: "Per LUBA's fairness rules, individual bid outcomes aren't shown — only the final result."
- **Public result (settled):** exactly the frozen projection — result, winning amount (when winner), close time, final accepted-bid count, prize, consented display name. Nothing more (no statistics, no distribution).

## 15. Fulfillment Flow (delivery / pickup)

- **Entry point:** after SETTLED(WINNER) receipt → `/fulfillment/:auctionId`; notifications deep-link here.
- **Delivery (primary):** guided address form (contact name, phone — verified default, region/city/sub-city/woreda, landmark) → submit → status timeline: `PENDING → ADDRESS_SUBMITTED → IN_PROGRESS → COMPLETED (with proof) | FAILED/UNRESOLVED`. Each status change = in-app record + SMS (frozen channels), idempotent.
- **Pickup (alternative):** pickup location card + instructions; verification code displayed; pickup confirmation recorded as proof.
- **Operator side:** fulfillment queue updates status and attaches proof/verification reference at completion (artifact format `[OPEN]`); winner sees the updated timeline in real time via subscription.
- **Success:** COMPLETED with proof reference shown to the winner; SMS confirmation.
- **Failure/exception:** FAILED/UNRESOLVED → visible to winner as an issue state with support path; appears in operator fulfillment/exceptions queues until resolved.

## 16. Notifications Flow

- **Entry point:** bell (unread dot) → `/notifications`; arrivals also surface on the relevant screens.
- **Contents (frozen channels: in-app + SMS only):** auction result, settlement status/deadline, settlement failure/NO_WINNER, fulfillment/pickup/delivery updates, system status history. Email does not exist as a channel.
- **Behavior:** every notification is an idempotent record keyed `(event, recipient, channel)` — duplicates impossible; send failures retry and surface in operator queues when exhausted. Deep links carry `returnTo` through auth (§3).
- **User actions:** tap → source screen; mark read; unread indicator on tab/bell.
- **Success:** user reliably learns of win/deadline/fulfillment (this is the trust-critical channel — TRD risk #6 mitigation).
- **Failure/exception:** SMS delivery failure → in-app record still exists; retry exhausts → operator notification-exceptions queue.

## 17. Profile / Settings / Language Flow

- **Entry point:** `/profile` from bottom tab "Profile" / rail.
- **User actions:** display name (publicDisplayName), public winner consent (explicit, default OFF), optional email, language EN/አማ (persisted per user, `<html lang>` updates), theme preference, verified phone (badge, read-only), sign out.
- **Success:** preference changes are instant and persisted; consent affects only future settled-result publications.
- **Failure/exception:** save errors inline; sign-out returns to `/` (public) with auth required again for protected routes.

## 18. Loading / Empty / Error / Retry States (global)

- **Loading:** spinners per project convention (no skeletons); buttons own their pending state (label → spinner, disabled, `aria-busy`); amounts never render placeholder dashes for more than a frame — interaction enables only after server values arrive via subscription.
- **Empty:** icon + one sentence + one action — every list surface (catalog, bids, notifications, wallet history, operator queues).
- **Error:** inline-first (field validation, transactional rejections); screen-level fetch failures get Retry; offline → slim persistent banner "You're offline — actions will fail until reconnected" + disabled money actions; provider/payment issues show honest pending language with "Check status," never premature "failed."
- **Retry:** all retries are idempotency-safe by design; replays return the original outcome.

## 19. Mobile Navigation Flow

- **Pattern:** top app bar (mark → `/`, bell with unread dot, EN/አማ toggle, theme) + **bottom tab bar: Home · Auctions · Wallet · Bids · Profile** (+ "Operator" entry for privileged users).
- **Transaction rhythm:** sticky bid panel on auction detail within thumb reach; full-screen money flows (deposit, settlement); receipt-style confirmations after every financial action — no silent back-navigation into a payment flow.
- **QA widths:** 375 and 430 primary; every money flow completable one-handed.

## 20. Desktop Navigation Flow

- **Pattern:** same app bar; bottom bar becomes a persistent left rail with **identical information architecture** (never divergent IA between breakpoints).
- **Composition:** featured-auction hero + catalog grids; auction detail with persistent right-rail bid panel; dashboard as two-column bidding cockpit; Operations console with dense queues/tables, keyboard row navigation.
- **QA width:** 1280 primary (768 tablet two-pane recomposition between).

## 21. Deep-Link Behavior

- **Every state is a URL:** auction, result, settlement, fulfillment, notifications.
- **Protected deep links:** unauthenticated → `/auth?returnTo=<path>` (preserved through sign-in, then exact restore). Verified-phone-required financial deep links → phone-verify step first.
- **SMS/notification links:** carry `returnTo` semantics; land on the exact state (settlement, fulfillment, result).
- **Invalid/stale links:** unknown ids → NotFound; superseded states (e.g., settlement link after void) → the current truthful state of that auction, never an error dead-end.
- **Operator links:** non-privileged users hitting `/operations/*` → dashboard (no privilege reveal).

## 22. Operator / Admin Flow — "LUBA Operations"

- **Entry point:** `/operations` (visible only to privileged class; exact role hierarchy `[OPEN]` — TRD freezes only regular-vs-privileged).
- **Landing = queue-first dashboard**, priority order (frozen by design authority): **live auctions → settlement queue → payment exceptions → inventory → fulfillment → withdrawals → financial exceptions.** Counts on each queue; zero-states are calm ("All clear").
- **Guardrails:** every money-touching/destructive action (cancel-before-open with RELEASE, manual exception resolution) requires a confirm dialog stating the economic consequence in one sentence; operator identity shown on every audit-visible action; all authorization server-side.
- **Navigation:** dense tables/queues with sticky headers, status filter chips, mono reference codes, keyboard row navigation; desktop-first (1280), mobile gets simplified read-only queue view.

### 22.1 Auction Creation / Configuration Flow

- **Entry:** Operations → Auctions → "Create auction" (stepper).
- **Steps:** Prize (from inventory) → **Inventory RESERVE confirmation** (available count shown; insufficient stock blocks publish with inline reason — an auction can never publish without a secured reservation) → Timing (schedule future or open now; per-auction start/end; anti-snipe fields appear only when parameters are configured `[OPEN]`) → Economics (fee/bounds rendered from frozen config; fields hidden while `[OPEN]`) → Fulfillment method (delivery/pickup + pickup details) → Review → Publish.
- **Lifecycle actions:** DRAFT → SCHEDULED (or OPEN directly, when appropriate); operator may view results at CLOSED/SETTLED; **cancel-before-open** triggers inventory RELEASE (audit-logged). No new public lifecycle states are introduced.
- **Success:** auction live with secured reservation; appears in marketplace per its state.
- **Failure/exception:** reservation failure (insufficient availability) → step blocks with reason; publish without reservation is structurally impossible.

### 22.2 Inventory RESERVE / COMMIT / RELEASE Flow

| Operation | Trigger | Atomic effect | User-visible consequence |
|---|---|---|---|
| **RESERVE** | Auction creation/configuration | Conditional decrement of inventory line `available` (serializes; loser fails with insufficient availability) | Publish gate passes only with secured reservation |
| **COMMIT** | Winner settles successfully (same transaction as settlement) | Reservation permanently consumed → winner's entitlement | Winner proceeds to fulfillment |
| **RELEASE** | (a) settlement-deadline void; (b) terminal NO_WINNER at close; (c) operator cancel-before-open | Reserved quantity restored to `available` | Prize returns to inventory; NO_WINNER/void messaging as frozen |

- **Inventory screen:** prize lines with available/reserved/committed counts + reservation history (which auction holds what); low-stock emphasis; concurrent auctions cannot promise the same physical inventory (reservation is the sole gate). Multi-auction quantity backing per line: `[OPEN]` (default dedicated line per auction).

### 22.3 Settlement / Exception Queues Flow

- **Settlement queue:** CLOSED auctions with settlement pending — deadline countdowns, reminder status, winner payment action trail; deadline lapse executes the frozen void-and-refund deterministically (idempotent sweep + mutation guards).
- **Payment exceptions:** unconfirmed provider events (deposit stuck pending), webhook verification failures — retry with same idempotency keys, "check status," manual resolution leaves an audit note.
- **Financial exceptions:** reconciliation mismatches (journal ≠ wallet projection, unbalanced entries), duplicate/replay attempt counters.
- **Fulfillment queue:** status columns, address/pickup drawer, status-update actions (frozen vocabulary), proof attachment at completion (format `[OPEN]`).
- **Withdrawals:** policy-level only; parameters `[OPEN]` — the queue/UI admits only what is configured; no invented payout mechanics.
- **Notification exceptions:** retry-exhausted sends (SMS failures at critical moments) with manual re-send where safe.
- **Success:** queues drain to zero; every resolution audit-logged.
- **Failure/exception:** unresolved items persist with escalating visibility; never silently dropped.

## 23. Authentication / Session Boundaries (summary)

- Sign-in = phone + OTP only; anonymous disabled everywhere; email optional profile data.
- Verified phone required for: deposit, bid, withdraw, settlement — enforced server-side, surfaced as friendly gates.
- Protected routes via `RequireAuth` with `returnTo` preservation; operator routes additionally privilege-gated server-side.
- Session state drives pure rendering: every screen renders a correct state for signed-out / signed-in-unverified / signed-in-verified / operator.

## 24. Major Edge Cases (explicit handling)

1. **Bid at the close boundary:** server guard rejects against authoritative `closeTime` (incl. anti-snipe-adjusted); client shows honest "Bidding has ended" + close time. Never pretends the bid landed.
2. **Anti-snipe extension during view:** countdown re-extends live with one-time pulse + copy; no CLOSING state; late-bid checks always use the current server-side close time.
3. **Winner never settles (deadline lapse):** deterministic SETTLED(NO_WINNER) + inventory RELEASE + full refunds incl. the defaulting winner's fees; respectful terminal UX (§12 failure branch).
4. **Duplicate economic submissions (double-tap/retry/replay):** idempotency keys make replays no-ops returning the original outcome — no double debits, no double credits, no double notifications.
5. **Deposit confirmed but user closed the tab:** webhook/server verification journals the deposit; on return the pending state resolves automatically via subscription — money is never lost or double-credited.
6. **Insufficient balance at settlement:** explicit gap + top-up path; deadline governs; top-up during the window is always available.
7. **Settled auction with unconsented winner name:** public result shows "Winner chose to stay anonymous" — consent-gated projection, default OFF.
8. **Auction with zero accepted bids at close:** winner determination yields NO_WINNER (no candidates); refund engine has nothing to refund; result publishes plainly.
9. **Stale client during state transitions:** subscriptions push state; any stale screen re-renders to the authoritative state on next read; actions re-validate server-side regardless of what the client believes.
10. **Offline during any money action:** banner + disabled actions; retry after reconnect is idempotency-safe.
11. **Unverified phone attempting any financial action:** gate with verify step; the action resumes after verification (intent preserved where applicable).
12. **Rate limiting / abuse patterns:** throttle messages (generic, uniform); no product consequence beyond throttling; anomalous patterns surface to operators — never a bid-count cap (`[OPEN]`).
13. **Currency/precision:** all amounts integer santims end-to-end; display-only formatting; no float anywhere in any flow step.
14. **Language mid-flow:** switching EN/አማ never resets a form or loses entered amounts; both languages fit the same states (no truncation of financial/deadline copy).

---

## OPEN Decisions Preserved (never assumed in any flow above)

1. Bid-fee model and amount (fee lines render only when configured).
2. Minimum/maximum bid amounts (bounds logic frozen; values `[OPEN]`).
3. Same-user same-amount repeat rule (validator is a config flag).
4. Per-user bid-volume cap (existence and value; anti-abuse throttling is not a cap).
5. Anti-snipe trigger window, extension duration, maximum extensions.
6. Settlement deadline duration.
7. Chapa-exposed deposit channels; links.et verification scope ("where applicable").
8. Withdrawal parameters (minimum, fees, payout methods, KYC, limits/cooldowns, approval, eligibility) and payout mechanism.
9. KYC/identity-verification depth beyond verified phone.
10. Live accepted-bid counter on OPEN auctions (TRD open question; default OFF — excluded from all flows).
11. Proof-of-fulfillment artifact format (photo vs. reference codes).
12. Exact privileged role names/hierarchy (two-class constraint frozen; naming `[OPEN]`).
13. SMS provider (Ethiopia coverage) for OTP + notifications.
14. Inventory line backing multiple concurrent auctions (default: dedicated line per auction).
15. Fulfillment geography/pricing/locations specifics (operator-configured; not invented).

---

*End of App Flow (v1.0). No code written; no implementation files modified.*
