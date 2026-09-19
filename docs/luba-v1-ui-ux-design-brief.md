# LUBA — V1 UI/UX Design Brief

**Document status:** FINAL (v1.0). UX and visual-behavior authority for LUBA V1.
**Basis:** Approved PRD (product authority) and finalized `docs/luba-v1-trd.md` (technical authority). Where the PRD freezes product behavior, this brief only designs its presentation; where the TRD fixes technical behavior (transactional statuses, whitelisted projections, server authority), this brief designs around it and never contradicts it.
**Out of scope here:** database schema (Backend Schema document), implementation architecture (TRD), task breakdown (Implementation Plan). No code is written in this document.

---

## 1. Design System

### 1.1 Theme concept — "Market Ledger"

LUBA is a trust-first money product with a game at its center. The visual language is a **market ledger**: the confidence of a bank statement with the energy of an open-air market. Dark ink surfaces, ledger-green accents for money-positive states, a single warm amber accent for live/urgent moments (countdowns, settlement deadline), and generous whitespace. Nothing decorative competes with amounts, timers, and statuses — they are the product.

- **Palette (oklch tokens in `src/index.css`, light + dark modes both required):**
  - `--primary`: deep market green — money-positive actions (deposit, bid confirm, settle)
  - `--accent`: warm amber — live/urgent states only (OPEN badge, deadline countdown, snipe-extension notice)
  - `--destructive`: red — rejections, void/NO_WINNER, refund-failure
  - Neutrals: near-black ink on warm paper white (light); warm charcoal (dark)
  - Semantic additions: `success` (accepted/settled/refunded), `warning` (pending settlement, deadline near), `muted` for secondary text
- **Typography:** one humanist sans for UI (system stack or Geist/Inter); **tabular numerals (`tabular-nums`) mandatory for every amount, fee, countdown, and bid number** — money must never reflow. Ethiopic text renders via Noto Sans Ethiopic fallback (see §11).
- **Borders over shadows:** thin 1px borders, no drop shadows (project convention). Depth comes from surface tint contrast, not elevation.
- **Radii:** consistent medium radius (shadcn default token); no mixed radii scales.
- **Iconography:** Lucide only, one weight, semantic color (green receipt, amber clock, red alert).
- **Data rhythm:** every screen follows *status → amount → action → detail* reading order. The user should always be able to answer "how much, until when, what can I do" in one glance.

### 1.2 Money display rules (non-negotiable)

- One shared presentation rule: integer santims → `ETB 1,234.56` (Birr with two santim decimals); thousands separators; `ETB` prefix always; no currency symbols invented.
- Amounts never animate, count up, or reformat mid-read. Fees are always shown **before** confirmation, never buried.
- Zero is displayed (`ETB 0.00`), never collapsed to "—", on wallet and settlement screens.

### 1.3 Status language

A single closed status vocabulary is reused everywhere (badges, timelines, notifications, SMS-preview text). Draft vocabulary aligned to TRD lifecycle/fulfillment states:

| Domain | Statuses |
|---|---|
| Auction | Draft (operator only) · Upcoming · Live · Ended · Settled |
| Result | Winner · No winner |
| Bid | Submitted · Accepted · Rejected · Refunded |
| Settlement | Pending · Paid · Failed/Expired |
| Fulfillment | Awaiting details · Preparing · Ready for pickup / Out for delivery · Completed · Issue |

Final wording is tuned during implementation; the rule is **one concept = one word, everywhere** (badge, SMS, timeline, email-free in-app record).

---

## 2. Responsive / Mobile-First Composition

- **Design order:** 360–430 px single-column first, then 768 px (two-pane where useful), then 1024 px+ (operator console territory). Every flow must complete one-handed on a 360 px viewport.
- **Touch targets:** minimum 44 × 44 px; primary actions are full-width buttons on mobile; destructive/financial confirmations are never adjacent to each other.
- **Thumb zone:** primary actions (Place bid, Deposit, Settle, Submit address) live in the bottom third; sticky bottom action bars on transactional screens (auction detail, wallet, settlement).
- **Sticky headers:** auction title + countdown stick under the app bar while bidding; wallet balance sticks on wallet screen.
- **Containers:** every page wrapped in a centered max-width container (no full-bleed stretching on wide screens — project convention); content column ~640 px max for reading surfaces, ~1100 px for catalog grids.
- **Catalog grids:** 1 column mobile → 2 tablet → 3–4 desktop; cards equal-height; no masonry.
- **Operator console:** sidebar navigation ≥1024 px, collapsible drawer below; tables get horizontal scroll with sticky first column; never cram admin tables into mobile cards — a simplified mobile admin view (queues + status) is acceptable, full editing is desktop-first.
- **No hover-dependent information:** every hover reveal has a tap/click equivalent (mobile-first rule).

---

## 3. Core Screens and Navigation

### 3.1 Screen inventory

**Public**
1. **Landing** — hero explaining LUBA in one sentence, how-it-works (bid → lowest unique wins → settle → receive), live auction preview cards, trust strip (ETB wallet, refunds, operator-curated prizes), EN/AM toggle, CTA into `/auth`. If signed in, primary CTA becomes "Dashboard".
2. **Auction catalog** — tabs/filters: Live · Upcoming · Settled. Cards show prize image, title, close countdown (Live), fee-per-bid (once frozen), fulfillment method chip, accepted-bid count per §3.3 note. Settled cards show result chip (Winner/No winner) + winning amount.
3. **Auction detail (public view)** — prize gallery, description, rules block (blind bidding explainer, fee, bounds, fulfillment method), countdown, bid panel (signed-in + verified) or sign-in prompt, result panel when settled.

**Authenticated (user)**
4. **Auth `/auth`** — phone number → OTP code → (first time) display-name step. One field per step, no tabs.
5. **Dashboard (post-auth home)** — live auctions you can act on, your active participations, wallet balance summary, settlement-deadline alert if applicable.
6. **Auction detail (bid view)** — the core screen (§4).
7. **Wallet** — balance hero, Deposit / Withdraw actions, transaction history (deposits, bid fees, refunds, settlements, withdrawals) with running statuses; withdrawal flow per PRD `[OPEN]` parameters (UI admits only what is configured).
8. **My bids** — per auction: own bid amounts, fee per bid, refund status post-close (exactly the PRD-frozen self-view; nothing else — no uniqueness, no ranking, ever).
9. **Notifications** — in-app history list (result, settlement, fulfillment, system), unread indicator, tap-through to source.
10. **Result screen (settled auction)** — public result block + own-bids block (§6).
11. **Settlement screen** — winner's payment flow (§5.3).
12. **Fulfillment screen** — address form (delivery) or pickup instructions (pickup) + status timeline (§5.4).
13. **Profile** — display name (public, optional), **public winner consent toggle (default OFF, explicit)**, optional email, language switch (EN/AM), phone (verified badge), sign out.

**Operator console** (privileged class; see §7)
14. Dashboard/queues · 15. Auction create/configure · 16. Inventory · 17. Results & settlements · 18. Fulfillment queue · 19. Exceptions (payments, notifications, reconciliation) · 20. Users (minimal lookup).

### 3.2 Navigation model

- **Mobile:** top app bar (logo → landing, notifications bell with unread dot, language toggle) + bottom tab bar: Home · Auctions · Wallet · Bids · Profile. Operator users additionally see an "Operator" entry.
- **Desktop:** same app bar; bottom bar becomes persistent left rail with identical items (never divergent IA between breakpoints).
- **Deep-linking:** every state is a URL (auction, result, fulfillment); notifications and SMS-linked flows deep-link with `returnTo` semantics via the existing auth wrapper.
- **Back behavior:** financial confirmations (bid, deposit return, settlement) always land on a receipt-style confirmation screen with explicit next steps — no silent back-navigation into a payment flow.

### 3.3 Blind-bidding display rule (applies to every surface)

Live auction surfaces may show: prize info, countdown, fee, configured bounds (once frozen), fulfillment chip, and **at most a live accepted-bids counter only if the owner later approves it (TRD Open Question — default OFF until decided)**. They must never show or hint: other bids, distribution, own uniqueness/duplication/leading status, "lowest unique so far," leaderboards, heat, or any competitive inference. This is a hard design constraint inherited from the PRD; violating it in copy (e.g., "be the lowest!") is treated as a defect.

---

## 4. Auction / Bidding UX

### 4.1 Auction detail — bid view (the money screen)

**Layout (mobile):** prize media → title + meta (condition, fulfillment chip) → rules block (collapsible "How LUBA works" with blind-bidding explainer) → **sticky bid panel** (amount input, fee line, primary button) → countdown prominently above the panel → own bids (this auction) below the fold.

**Bid panel behavior:**
1. Amount entry: large numeric keypad-friendly input; ETB formatted live from integer santims; min/max bounds (once frozen) shown as helper text and enforced inline (no toast-only errors).
2. Fee line: "Bid fee: ETB X.XX · You pay: ETB X.XX" — always visible before the button is enabled. Fee model/amount is PRD `[OPEN]`: until frozen, the panel shows the input and a disabled state with "Bidding opens soon" rather than an invented price.
3. Confirmation: one tap places the bid; no extra modal for a normal bid (friction belongs to money-out flows, not bid placement rhythm); the button shows a brief submitting state.
4. **Outcome = transactional status only** (TRD §8): inline status line under the panel — *Accepted* (green, with new own-bid row appended) or *Rejected* with reason class: *Insufficient balance* (with Deposit CTA), *Bidding has ended*, *Out of range*, *Already placed* (if the same-amount rule `[OPEN]` is configured to block). No spinner-based fake latency, no optimistic "unique!" hints.
5. Insufficient balance: the panel switches to a "Top up to bid" state with a deposit shortcut; the bid intent (amount) is preserved through the deposit return flow.
6. Own bids list (live): own amounts + status badges only, newest first. No ranking, no counters, no comparison.

**Countdown:** server-provided `closeTime` rendered as `HH:MM:SS` in tabular numerals; amber accent in the final hour; **display only** — no client-side urgency tricks, no fake extensions. If the server extends (anti-snipe, params `[OPEN]`), the countdown visibly re-extends with a one-time subtle pulse + helper text "Extended — bidding continues"; never a scary red flash.

**Late/boundary edge:** if the user taps Place bid as the auction closes, the server's rejection ("Bidding has ended") is surfaced honestly with the authoritative close time; the client never pretends the bid landed.

### 4.2 Catalog & discovery

- Live cards lead with countdown + prize; Upcoming cards lead with start time + "Remind me" (in-app notification intent only — no email); Settled cards lead with result chip.
- Filter chips (category, fulfillment method, status) are single-tap toggles; search matches title/description.
- Empty/zero states follow §8.

---

## 5. Wallet, Payment, Settlement, Fulfillment UX

### 5.1 Wallet

- **Balance hero:** large `ETB` figure (tabular), last-4-updated timestamp ("Updated just now"), two actions: **Deposit** (primary), **Withdraw** (secondary; disabled with explanatory tooltip while PRD withdrawal parameters are `[OPEN]` — never hidden, never a dead end).
- **Transaction history:** grouped by day; each row = direction icon, label (Deposit / Bid fee / Refund / Settlement / Withdrawal), amount signed, status badge (Pending/Completed/Failed); tap → detail sheet with idempotent reference code shown to the user (support/disputes anchor).
- **Deposit flow:** amount entry (preset chips + custom) → Chapa hosted checkout (client receives only the hosted URL per TRD) → **"Confirming your payment" pending screen** with honest copy ("We're confirming with your provider — this usually takes a moment; your balance updates automatically") → auto-transition on wallet credit (subscription push) → success receipt. If the user returns without confirmation: pending state persists with "Check status" + "Try another method"; the UI never credits optimistically.
- **Withdrawal flow:** admits only configured parameters; while `[OPEN]`, the entry point shows "Withdrawals are coming soon" state with the frozen policy sentence ("LUBA supports withdrawals; rules are being finalized") — no fake form.

### 5.2 Bid-fee economics transparency

- A persistent "How fees work" sheet from every bidding surface: fee is charged per accepted bid at placement; fees are refunded only on no-winner outcomes; winner pays the winning amount separately at settlement. Plain language, EN/AM, no fine-print burial.

### 5.3 Settlement UX (winner)

- **Win moment:** full-screen (mobile sheet) result: prize, winning amount, **settlement deadline countdown** (amber), two actions: **Pay ETB X.XX from wallet** (primary) and **Top up** (if balance insufficient — balance gap shown explicitly: "You need ETB Y more").
- **Pending settlement state (CLOSED, before payment):** dashboard + auction screen show a persistent, dismissible-but-recurrent alert: "You won — pay by <deadline> or the auction is voided and all bids are refunded." SMS reminders (frozen channel) mirror this copy; in-app notification records mirror it too.
- **Payment:** one confirm step showing the exact debit ("Wallet: ETB A → ETB A−X"); success receipt screen → "Provide delivery details" next step (delivery) or "Pickup instructions" (pickup). Idempotent by design (TRD): double-tap is safe; the button disables after first press with a submitting state.
- **Deadline lapse (void):** the winner sees a respectful terminal state: "Settlement window closed — the auction ended with no winner. Your bid fees have been refunded to your wallet." Deep-link to wallet showing refund rows. No blame language, no re-award promise.

### 5.4 Fulfillment UX

- **Delivery:** guided address form (contact name — prefilled from verified phone context, phone (editable, verified default), region/city/sub-city/woreda, landmark note) with inline validation; submit → status timeline opens.
- **Pickup:** pickup location card (name, address, hours — operator-configured), instructions, "I'm on my way" style status acknowledgments as configured; verification code displayed for pickup confirmation.
- **Timeline:** vertical stepper of the §1.3 fulfillment statuses with timestamps; every status change also lands as in-app record + SMS (frozen); terminal Completed shows proof reference (e.g., confirmation code) — proof artifact format is TRD `[OPEN]`, UI accommodates code-or-reference display.

---

## 6. Result / Post-Close UX

- **Public result block (settled auction):** result chip (Winner/No winner), winning amount (if winner), close time, final accepted-bid count, prize recap, winner display name **only when consented** — otherwise "Winner chose to stay anonymous." Nothing else is shown; the UI must not invent statistics (no "X bidders competed," no distribution visuals).
- **Own bids block (post-close):** table of own amounts + fee + refund status. Explicitly no uniqueness/ranking columns. A quiet helper line: "Per LUBA's fairness rules, individual bid outcomes aren't shown — only the final result."
- **NO_WINNER close (no unique bid):** public result explains plainly: "Every amount was bid more than once, so there is no winner. All bid fees have been refunded." Participants see refund rows in wallet/My bids.
- **Winner consent:** profile toggle with explicit copy: "Show your display name on auctions you win (default: hidden). Winning never turns this on automatically."

---

## 7. Admin (Operator) UX

- **Design stance:** dense, calm, keyboard-first data tooling — a ledger console, not a marketing dashboard. Same design system, `muted` surfaces, tighter spacing, tables over cards.
- **Dashboard/queues:** four priority queues with counts: Settlements pending · Fulfillment in progress · Exceptions (unconfirmed payments, failed notifications, reconciliation) · Draft auctions. Zero-state queues are celebrated ("All clear").
- **Auction create/configure:** stepper — Prize (from inventory) → Inventory RESERVE confirmation (available count shown; insufficient stock blocks publish with inline reason) → Timing (start mode: schedule future or open now; end time; anti-snipe fields shown only when parameters are configured — never `[OPEN]`-guessed) → Fee/bounds (rendered from frozen config; fields hidden while `[OPEN]`) → Fulfillment method (delivery/pickup + pickup details) → Review → Publish. Draft autosave; explicit publish confirmation.
- **Inventory:** list of prize lines with available/reserved/committed counts; reservation history per line (which auction holds what); low-stock emphasis.
- **Results & settlements:** settled auction list with result, settlement status, deadline adherence; drill-in shows the frozen public projection plus operator-only financial detail (per TRD visibility boundary).
- **Fulfillment queue:** status columns, address/pickup detail drawer, status-update actions matching §1.3 vocabulary, proof attachment step at completion.
- **Exceptions:** every TRD §25 queue item with idempotency/reference codes, retry actions where safe, and "resolve manually" flows that always leave an audit note.
- **Guardrails:** destructive or money-touching operator actions (cancel auction with reservation release, manual exception resolution) use confirm dialogs that state the economic consequence in one sentence. Operator identity is shown on every audit-visible action ("as <name>").

---

## 8. Loading / Empty / Error / Success States

**Loading**
- Spinners (Loader2-style) for data fetch and action submits per project convention — **no skeleton loaders**.
- Buttons own their pending state (label → spinner, disabled); screens never double-spin (one global route transition indicator max).
- Amounts/countdowns never show placeholder dashes for more than one frame; server values arrive via subscription before interaction is enabled.

**Empty**
- Every empty state = icon + one sentence + one action: Catalog ("No live auctions right now — see what's coming up" → Upcoming tab), My bids, Notifications, Wallet history, Fulfillment (pre-settlement: "Fulfillment starts after you complete settlement"), Admin queues.
- Empty is never an error and never blank.

**Error**
- Inline-first: field-level validation (bounds, address), panel-level transactional rejections (§4.1), screen-level for fetch failures with Retry.
- Network loss: persistent slim banner "You're offline — actions will fail until reconnected"; bidding button disabled rather than silently failing.
- Provider/payment errors: honest pending language, never "failed" unless the ledger says so; always offer "Check status."
- Error copy never leaks internals, never hints at other bids or uniqueness.

**Success**
- Financial successes land on receipt-style confirmations: amount, reference code, what happens next (e.g., "Your bid is in. You'll see the result after the auction closes.").
- Toasts for lightweight confirmations (language changed, address saved); full confirmations for money events.
- Every success states the next observable event ("You'll get an SMS when your prize is out for delivery").

---

## 9. Accessibility & Keyboard Behavior

- **Target: WCAG 2.2 AA** (TRD-frozen): focus-visible rings on all interactives; 24 px minimum target spacing / 44 px mobile targets; no drag-only interactions; consistent help placement.
- **Keyboard:** full tab order following visual order; Enter submits focused form; Escape closes sheets/dialogs with focus return; skip-to-content link; operator tables support arrow-key row navigation.
- **Countdowns:** `aria-live="polite"` with throttled announcements (e.g., at 10 min/1 min boundaries, not per second); raw timestamp available in a title/visually-hidden form.
- **Bid status changes:** announced via polite live region ("Bid accepted"); color never the sole carrier (badge text + icon).
- **Forms:** labels always visible (no placeholder-as-label); errors in text linked via `aria-describedby`; OTP input supports paste and auto-advance.
- **Contrast:** all token pairs verified ≥ 4.5:1 (text) / 3:1 (large text & UI edges) in both modes; amber-on-dark and green-on-dark checked explicitly.
- **Motion:** all animation gated on `prefers-reduced-motion` (see §12).
- **Language:** `lang` attribute switches with EN/AM toggle (see §11).

---

## 10. Motion Principles

- **Purposeful only:** motion communicates state change (enter/exit, pending→result, extension pulse, sheet transitions) — never decoration for its own sake.
- **Framer Motion patterns (project standard):** fade/slide-in for list items and route content (150–250 ms, ease-out); spring for sheets and bottom bars; number/amount values do **not** animate.
- **Feedback hierarchy:** button press scale ≤ 0.98; accepted-bid row gets a single subtle highlight pulse; countdown extension gets one gentle pulse + copy.
- **Reduced motion:** all transforms/opacity animations collapse to instant state changes under `prefers-reduced-motion`; nothing essential is conveyed by motion alone.
- **No motion on money truth:** balances, fees, and settlement amounts appear at final value — no count-up theatrics on financial figures.

---

## 11. English / Amharic / i18n Rules

- **Both languages ship for all core flows at launch** (PRD-frozen). Lightweight keyed dictionary (no heavy i18n framework); every user-visible string is a key — no hardcoded copy, including SMS-mirroring in-app records and error/reason classes.
- **Amharic typography:** Noto Sans Ethiopic (or system Ethiopic fallback) loaded for Geez script; line-height relaxed (+10–15%) for Ethiopic; never italicize or letterspace Ethiopic; numerals stay Western Arabic with `tabular-nums`.
- **Text expansion:** EN→AM can expand 1.5–2×; buttons/labels sized for the longer language (AM) or allowed to wrap to two lines; no truncation of financial or deadline copy; test both languages on every screen.
- **Mixed-direction safety:** Amharic is LTR; amounts and codes embedded in AM sentences are wrapped as isolated spans so formatting never breaks mid-sentence.
- **Language switch:** persistent toggle in app bar + profile; preference persisted per user; `lang` attribute updates; date/number formatting stays constant across languages (ETB format, Addis-time presentation default per TRD §17 — presentation timezone is a reversible default, not a constraint).
- **Names/dates:** user-generated display names render as-is in both languages; dates as "19 Sep 2026, 14:30" pattern (unambiguous, locale-stable).

---

## 12. Component Patterns

Reuse shadcn primitives by default; the following are LUBA-specific composites (specified here, built in implementation):

- **`<Money>`** — the only money renderer: integer-santim input → formatted ETB string; variants: default / large (balance hero) / signed (ledger rows); always tabular-nums; never accepts preformatted strings.
- **`<Countdown>`** — server-time-anchored, display-only; variants: inline (card), hero (auction), deadline (settlement, amber); accessible announcements built in; renders "Ended" state from server truth, never client math.
- **`<StatusBadge>`** — single source of the §1.3 vocabulary; color + icon + text; one component so a status can never diverge between screens.
- **`<AuctionCard>`** — prize image, title, status/countdown slot, fee slot (when frozen), fulfillment chip, result slot (settled); no nested cards.
- **`<BidPanel>`** — the §4.1 state machine rendered: input → fee line → action; states: idle / submitting / accepted / rejected(reason) / ended / needs-topup / not-verified / not-open. State, not screens — one component, deterministic transitions.
- **`<OwnBidsList>`** — frozen self-view columns only (amount, fee, refund status); structurally incapable of showing more (mirrors TRD whitelisted projection).
- **`<TxRow>` / `<TxDetail>`** — wallet ledger rows/detail sheet with reference codes.
- **`<Timeline>`** — fulfillment/settlement steppers driven by status records.
- **`<ConsentToggle>`** — winner-consent switch with explanation copy; default off; never bundled into other forms.
- **`<QueueTable>`** — operator tables: sticky header, row selection, status filter chips, keyboard navigation.
- **`<EmptyState>` / `<ErrorState>` / `<ReceiptScreen>`** — standardized §8 patterns.
- **Sheets over pages:** secondary flows (bid detail, tx detail, address form on desktop) use sheets/dialogs with scroll containment (project convention); primary flows (settlement, deposit) are full screens on mobile.

---

## 13. Design Anti-Patterns (explicitly forbidden)

1. **Any leak of competitive bid information** — leaderboards, "you're currently winning/unique," heat indicators, live lowest-unique hints, distribution charts. Hard PRD violation.
2. **Fake urgency or dark patterns** — invented timers, "X people are watching," loss-framed nudges on fees, pre-checked consent, hidden fees revealed post-action.
3. **Optimistic money** — crediting balances, marking bids accepted, or showing settlement as paid before server/ledger truth; skeleton amounts; animated count-ups on financial values.
4. **Nested cards / shadow stacking** — project convention violations that erode the ledger aesthetic.
5. **Skeleton loaders** — replaced by spinner + subscription-first data (project convention).
6. **Hover-only affordances** and desktop-first layouts squeezed onto mobile.
7. **Placeholder-as-label** forms; error toasts for field validation; dead-end disabled buttons (disabled must always say why).
8. **Invented statistics** on results ("87% of bids were duplicates") — the PRD freezes the public projection; nothing may be added.
9. **Buried settlement deadline** — the void consequence must be unmissable from win moment to deadline; hiding it behind a badge is a defect.
10. **Consent dark patterns** — winner publicity opt-in pre-checked, bundled, or rewarded.
11. **Copy that promises what V1 doesn't do** — no runner-up hints ("next lowest wins"), no external-refund promises, no withdrawal promises beyond the frozen policy sentence.
12. **Bilingual afterthoughts** — English-first layouts that break with Amharic expansion; machine-translated-feeling strings; un-localized SMS-mirroring records.

---

## 14. Design-Source Principles and LUBA's Adaptation

- **Nielsen's heuristics (visibility of system status, error prevention, recognition over recall):** LUBA adapts them to a *blind* game — status visibility is deliberately asymmetric: rich transactional feedback about *your own* actions (accepted/rejected/refunded), deliberate silence about the competitive field. Error prevention is financial-first: bounds inline, fee pre-disclosure, confirm-on-debit, idempotent double-tap safety.
- **Swiss/International Typographic Style:** grid discipline, tabular data as the hero, type-led hierarchy, minimal ornament — adapted to make the ledger feel authoritative; amounts and statuses are set like a bank statement, not a game show.
- **Material Design feedback & state layers:** pressed/selected/disabled state legibility and motion-with-meaning — adapted through Framer Motion springs/sheets while keeping shadows off (borders carry structure instead).
- **Mobile-money UX conventions (Telebirr/M-PESA-era patterns):** confirmation-code culture, PIN-free hosted handoff, explicit pending states, receipt-first completions — LUBA adopts the *trust choreography* (pending → confirmed → receipt with reference) while replacing provider screens with Chapa hosted checkout per TRD.
- **Auction-house restraint (Sotheby's/ Christie's lot pages):** prize photography, editorial typography, calm countdowns — adapted for Ethiopian market warmth (amber accent, green money semantics) and mobile-first density.
- **Progressive disclosure (form design best practice):** steppers for operator auction creation and address capture; advanced rules collapsed behind "How LUBA works"; nothing financial hidden more than one tap deep.
- **Inclusive design (Microsoft guiding principles):** permanent captions for critical events (SMS mirrored in-app), reduced-motion parity, bilingual parity from day one — accessibility and language are launch constraints, not retrofit.

---

## 15. Freeze Notes

- Presentation details (exact copy, spacing, final status wording, illustration style) are tuned during implementation within these constraints.
- Items intentionally left to future decisions rather than designed here: live accepted-bid counter (TRD Open Question — default OFF), withdrawal form (PRD `[OPEN]` parameters), fee display values (PRD `[OPEN]`), proof-artifact format (TRD `[OPEN]`), anti-snipe copy specifics (parameters `[OPEN]`).
- This brief is the UX authority for the Implementation Plan; conflicts resolve in PRD → TRD → this brief order.
