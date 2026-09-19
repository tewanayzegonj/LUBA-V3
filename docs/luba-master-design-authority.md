# LUBA — Master Design Authority

**Direction: LUBA PULSE**
**Document status:** ACTIVE (v2.0). This is the single design authority for LUBA.
**Supersedes:** The previous visual direction — "warm paper + warm obsidian + restrained brass" (the "Market Ledger" theme in `docs/luba-v1-ui-ux-design-brief.md` §1.1). That direction is no longer the primary LUBA visual identity.
**Basis:** Approved PRD (product authority) and finalized `docs/luba-v1-trd.md` (technical authority). This document governs *visual and interaction identity*; it never overrides frozen product behavior (blind bidding, money rules, publication boundaries) or TRD technical constraints.
**Implementation status:** Nothing in this document is implemented yet. It directs future UI/UX Brief revision, App Flow, and implementation work.

---

## 1. Authority & Scope

- This authority defines brand character, themes, color, typography, brand mark, motion, interaction states, composition, imagery, and accessibility direction for every LUBA surface.
- Where this document and any older design prose conflict, **this document wins**.
- Frozen product rules that survive untouched (from PRD/TRD and the existing brief's behavioral sections): blind-bidding display rules, money formatting (integer santims → `ETB X.XX`), the closed status vocabulary, public/private result boundaries, receipt-first money flows, idempotent actions, WCAG 2.2 AA, EN/AM bilingual parity.
- The UI/UX Design Brief remains the behavioral/UX authority for flows; its **visual sections are superseded** by this document and must be revised to inherit PULSE (see §20).

---

## 2. Direction Reset Summary

**Superseded (no longer LUBA's identity):**
- Warm paper foundation, warm obsidian surfaces, restrained brass accents.
- Market green as the primary brand color; amber as the live/urgent accent.
- The "market ledger / bank statement" metaphor as the primary brand feeling.

**Surviving (unchanged product/UX law):**
- Blind bidding display constraints (§3.3 of the UI/UX brief) — still a hard PRD constraint on every new visual surface.
- Money display rules, fee pre-disclosure, receipt-first confirmations.
- Status vocabulary, publication projection, consent-gated winner name.
- Accessibility (WCAG 2.2 AA), reduced-motion parity, EN/AM rules.
- Anti-pattern list (§13 of the brief) minus items that referenced the old palette.

**Why PULSE:** LUBA is a bidding product — the interface must carry energy and anticipation (a pulse) while staying premium, precise, and trustworthy. The energy comes from color, motion, and typography rhythm — never from casino tropes, neon, or noise.

---

## 3. LUBA PULSE — Brand Character

**Core character:** vibrant · premium · polished · energetic · modern · trustworthy · precise · human-designed.

**Reference blend:** premium auction house × modern fintech × high-end digital marketplace.
- *Auction house:* editorial confidence, product imagery as hero, calm authority around value.
- *Fintech:* precision, tabular data discipline, honest states, tactile controls.
- *Marketplace:* desire, momentum, clear commercial actions.

**It must feel exciting** — because bidding is exciting — **and must never feel:**
- Casino-like (no chips, slot machines, confetti-frenzy, red/gold gambling cues)
- Crypto-like (no neon glows on everything, no token aesthetics, no tech-bro dark UI)
- Neon overload (accents are precise instruments, not wallpaper)
- Generic SaaS (no icon+number stat-card grids, no interchangeable admin template look)
- Purple AI-gradient design (explicitly banned; see §5)
- Childish/gamified (no badges-for-everything, no cartoon mascots, no streak pressure)
- Visually noisy (one focal point per screen; whitespace is part of the luxury)

**Human-designed:** asymmetric editorial compositions, deliberate typographic moments, authored imagery — over templated symmetry and stock decoration.

---

## 4. Theme System — "Pearl & Midnight"

LUBA ships **two first-class themes that are unmistakably one brand**. The dark theme is not "black + gold"; it is a midnight-navy world where the same accent family glows at different intensities.

### 4.1 Light — "Pearl"
- Foundation: refined pearl / cool-ivory canvas (cool, not cream; no yellow cast).
- Surfaces: clean white cards on the pearl canvas; separation via subtle borders and very soft elevation.
- Typography: deep ink on light; strong contrast; vibrant accents carry energy.
- Atmosphere: faint cool tint and controlled white space; accents used sparingly as jewelry.

### 4.2 Dark — "Midnight"
- Foundation: rich midnight/navy (a deep blue-black, never pure `#000`).
- Surfaces: layered dark surfaces (base → raised → overlay) creating depth through lightness steps, not heavy shadows.
- Typography: bright, high-contrast text; same hierarchy as light.
- Atmosphere: subtle depth gradients and faint accent auroras permitted behind hero/brand moments only (see §5 gradient policy).

### 4.3 One-brand rules
- Identical semantic color roles in both themes; only intensity/lightness tuned per theme.
- Identical type scale, spacing, radii, icon style, motion timings.
- Theme switching is instant and complete — no half-themed screens; both themes pass the same contrast checks (§18).
- Imagery must be art-directed to sit naturally on both foundations (§16).

---

## 5. Color System

A restrained but vibrant semantic palette. Five families, each with one job.

| Role | Family | Light (indicative) | Dark (indicative) | Usage |
|---|---|---|---|---|
| Primary action | **Cobalt / electric blue** | `#1D5BF0` | `#5B8CFF` | Primary CTAs (Place bid, Deposit, Settle), active controls, key links, focus rings |
| Live / activity | **Electric aqua** | `#0899B4` | `#2FD4E8` | LIVE badges, live auction signals, "bidding is happening" states |
| Winner / value / premium | **Warm gold / champagne** | `#B98A1F` | `#E8C468` | Winner reveal, WON states, premium/featured emphasis — never for errors or urgency |
| Urgency / errors | **Coral** | `#E14B3C` | `#FF7A6B` | Ending-soon urgency, rejections, errors, destructive actions only |
| Structure | **Deep ink + cool neutrals** | Ink `#0B1220`, neutrals `#5A6472` / `#E3E7EC` | Ink `#F2F5FA`, neutrals `#94A0B4` / `#24324E` | Text, borders, surfaces, secondary information |

Supplementary semantic: **success** (completed/settled/refunded) uses a restrained deep green *as a semantic state color only* — small badges and check icons, never the brand/primary color, never large surfaces.

**Hard prohibitions:**
- **No green as the primary brand color.** Green appears only in tiny success semantics.
- **No purple/blue "AI-style" gradients** anywhere.
- **No neon overload:** accent colors appear on ≤ ~10% of any screen; the rest is foundation + neutrals.
- Coral is never decorative; gold is never urgent; aqua is never an action color; cobalt is never an alert color. Role discipline is absolute.

**Gradient policy:** gradients may exist **only** to create intentional depth or atmosphere (e.g., a faint cobalt→aqua aurora behind a hero or winner reveal, a soft vignette on imagery). They must never dominate the interface, never color text beyond white/ink, never appear on form surfaces, tables, or money displays.

Implementation note: final oklch token values are tuned at implementation; the role table above is the binding semantic contract.

---

## 6. Typography System

| Family | Role | Notes |
|---|---|---|
| **Manrope** | UI / body — all product surfaces | Weights 400/500/600/700/800. The voice of the product: modern, precise, slightly warm. |
| **Fraunces** | Selective major display / brand moments | Landing hero, featured-auction headline, winner reveal, brand storytelling. Never in body copy, never in financial data, never in admin. |
| **Noto Sans Ethiopic** | Amharic (አማርኛ) | Required for EN/AM parity (§18); relaxed line-height for Ethiopic; never italicized or letter-spaced. |
| **IBM Plex Mono** | Auction codes, reference/idempotency codes, OTP digits, technical & financial values where appropriate | Signals machine-precision; used for identity codes and tabular data moments, not for prose. |

**Precision rules:**
- **Tabular numerals (`tabular-nums`) are mandatory** for every amount, fee, countdown, bid count, and code — money and timers must never reflow.
- Marketing surfaces (landing, featured auction) are **expressive**: larger display sizes, Fraunces moments, generous leading.
- Bidding/financial surfaces are **extremely precise**: smaller sizes, tight information density, mono/tabular data, no decoration within ±1 step of a financial figure.
- Type scale: one shared scale (12/14/16/20/24/32/48/64 approx.), display sizes reserved for brand moments.
- Font files (all open-licensed) are self-hosted as an implementation task, with Ethiopic subset loading and `font-display: swap`.

---

## 7. Brand Mark & Wordmark

The mark must feel authored, memorable, and premium — **not generic AI geometry, not an unrelated library icon**.

### 7.1 Concept — "The Lowest Unique Point"
LUBA's story in one shape: a **pulse line that descends and terminates in a single, distinct point** — the lowest unique bid. A heartbeat (energy, the pulse) that ends at the one point that wins (precision, uniqueness).

- A short sequence of descending strokes reads as motion/energy (the pulse).
- The final stroke drops below the baseline and is capped by one solid dot — the unique winner.
- The dot is the mark's anchor: it must survive at 16 px (favicon) as just **dip + dot**.

### 7.2 Required variants (deliverables at implementation)
1. Mark only (square icon / app icon / favicon).
2. Mark + "LUBA" wordmark lockup (horizontal).
3. Monochrome single-color (ink on light, light on dark — the mark must never depend on color).
4. Cobalt, aqua, gold, and coral accent treatments (marketing use only; the dot may take gold in winner contexts).
5. Sizes: 512 app icon → 192/32/16 favicon; legible at 24 px in a nav bar, and beside the wordmark at all sizes.

### 7.3 Construction rules
- Geometric grid construction, consistent stroke weight, optically balanced spacing.
- Works independently, beside the wordmark, in light theme, dark theme, and monochrome.
- The wordmark: "LUBA" set in Manrope 800, slightly tight tracking — the mark carries the story; the wordmark carries the name.
- Fraunces may set the wordmark **only** in brand/editorial contexts (landing hero), never in product chrome.
- No gradients inside the mark; at most a subtle atmospheric halo behind it in hero contexts.

> Note: the mark's concept and construction rules are defined here; the final drawn artwork is produced and visually verified with the owner at implementation (owner approves rendered versions in preview).

---

## 8. Sign-In Experience

Inspired by the owner's uploaded sign-in reference — its **simplicity, strong visual identity, premium composition, and focused authentication**. *(The reference is not stored in the project filesystem and cannot be viewed as pixels by the coding agent; the qualities above are captured from the owner's description. LUBA's version is an original composition, not a copy.)*

- **Composition (desktop):** a two-panel split. Left: the **brand stage** — deep-ink or midnight panel with the pulse mark, a short Fraunces statement ("The lowest unique bid wins."), a restrained atmospheric gradient, and one art-directed prize image. Right: the form on Pearl. Mobile: single column — compact mark + wordmark on top, form in the thumb zone.
- **The form is the product of this screen and it must stay simple:**
  1. Phone number step — one large, beautifully spaced input with clear country context (ETB/Ethiopia audience), single primary CTA.
  2. OTP step — six large segmented digits in IBM Plex Mono, auto-advance, paste support, resend with honest countdown, one primary CTA.
  3. First-time only: display-name step, one field.
- No social buttons, no tabs, no marketing clutter, no email option (phone + OTP only per PRD; anonymous sign-in disabled).
- **Polish:** ≥ 56 px inputs on mobile; 2 px cobalt focus rings; generous vertical rhythm; button pressed states feel tactile (§14).
- **Motion:** step transitions fade/slide at standard timing (§13); subtle brand-stage ambience (never animated loops); input focus glow in cobalt; error is coral text + icon — no shake under reduced motion.
- **Both themes** fully designed; language toggle (EN/አማ) visible on the screen; the brand stage adapts its panel per theme (ink on Pearl, midnight on Midnight).
- Verification is real: no fake "verified" states; OTP errors surface honestly with retry.

---

## 9. Marketplace

LUBA is designed as a **true premium auction marketplace** — closer to an editorial auction-house catalogue than an app dashboard. Priority order of the marketplace surface:

1. **Featured auction** — one hero auction: large art-directed imagery, Fraunces display headline, LIVE badge, prominent countdown, bid-economics strip (fee once fee is frozen — never invented), and the strongest bid CTA on the page.
2. **Live auctions** — countdown-led cards (aqua LIVE badges).
3. **Upcoming auctions** — start-time-led cards, "Remind me" (in-app intent), neutral ink badges.
4. **Settled / result history** — result-led cards (Winner with gold emphasis / No winner in neutral ink), winning amount when applicable.

### Auction card anatomy (every card, all sizes)
- **Product imagery** as the largest element (3:2 or 4:3, art-directed per §16).
- **Live state:** badge (aqua LIVE / neutral UPCOMING / ink SETTLED) — status never conveyed by color alone (icon + text).
- **Countdown:** tabular numerals, `HH:MM:SS`; coral tint only in the final-window state ("ending soon"), per §15.
- **Bid economics:** fee line ("Bid fee ETB X.XX") only when the fee is configured; bounds when configured. Nothing invented while PRD values are `[OPEN]`.
- **Auction identity:** title + auction code in IBM Plex Mono.
- **Clear bid action:** cobalt button ("Bid now") on live cards; honest secondary states otherwise ("Opens <time>", "View result").
- **Blind-bidding law applies:** cards show only transactional/public facts (countdown, fee, fulfillment chip, settled result, final accepted-bid count after close). No competitive inference, no "X bidders competing" teasers, no live counter unless the owner later approves it (TRD Open Question — default OFF).

**Explicitly forbidden:** generic dashboard card grids (icon + number + label tiles), uniform SaaS stat rows, decorative icon headers.

---

## 10. Auction Detail — The Signature Experience

The auction detail page is **the** LUBA experience — where the brand's energy and precision meet. Visual hierarchy, in strict order:

1. **Product** — large imagery, gallery; the prize is the star.
2. **Live state** — LIVE badge (aqua) or UPcoming/settled equivalent.
3. **Countdown** — large, tabular, always visible; sticks with the bid panel on mobile scroll.
4. **Economics** — bid fee, bounds, fulfillment method chip (only configured values).
5. **Bid control** — the tactile centerpiece (below).
6. **Rules** — "How LUBA works" explainer (blind bidding, lowest unique wins, settle-to-claim) with a small purposeful diagram (§16).
7. **Own bid state** — the user's own bids for this auction: transactional status only (accepted/rejected/refunded), never uniqueness or ranking.
8. **Auction information** — code, dates, operator, result when settled.

### The bid control
- Must feel **tactile and important**: a substantial panel (the strongest visual element on the page after imagery), large amount input, clear fee line, and a big cobalt **Place bid** button with premium hover/press/loading states (§14, §15).
- Desktop: persistent right-rail panel beside the product. **Mobile: sticky bottom panel within thumb reach** — the bid action is never more than a thumb's travel away; the page scrolls beneath it.
- States are honest and instant: submitting → accepted (aqua/gold highlight + receipt line) or rejected with reason class (coral) — exactly the TRD transactional statuses.
- Insufficient balance flows into a "Top up to bid" state preserving the entered amount.
- No casino anticipation effects: no spinning rims, no fake suspense, no "revealing" animations on bid placement. Excitement = speed, clarity, and craft.

---

## 11. User Dashboard — The Bidding Cockpit

**Not a generic SaaS dashboard.** The dashboard is a personal **bidding cockpit**: one screen that answers "what's my money, what am I bidding on, what needs me, what did I win."

Composition uses **strong hierarchy instead of many small cards**:

1. **Wallet** — dominant header block: balance (large tabular figure), Deposit primary action, Withdraw secondary (honest state while PRD parameters are `[OPEN]`), recent money movement.
2. **Continue bidding** — the auctions the user is actively in, each with countdown + fee + bid CTA; the most actionable surface, placed high.
3. **Active bids** — own bids in live auctions (amounts + status only).
4. **Won auctions** — settlement deadline countdown or fulfillment status, surfaced with gold/winner emphasis and unmissable settlement alerts (per the frozen settlement choreography).
5. **Notifications** — the user's notification feed (arrival honors §13 motion).
6. **Settlement-deadline alert** (when applicable) — persistent, coral-accented, consequence-stated: pay by deadline or the auction is voided and fees refunded.

Max ~2 columns on desktop; single column mobile; **no grid of small stat tiles**. Every module earns its place through actionability.

---

## 12. Admin — "LUBA Operations"

A distinct **LUBA Operations** visual language: calm, dense, operational — the same brand family at lower emotional temperature.

- Priorities, in order: **live auctions → settlement queue → payment exceptions → inventory → fulfillment → withdrawals → financial exceptions.**
- **Queue-first IA:** operator lands on prioritized queues with counts; zero-states are calm and celebratory-free ("All clear").
- **Elegant dense tables/queues:** tight rows, sticky headers, tabular numerals, mono reference codes, keyboard row navigation, saved filters. Density is a feature — whitespace budgets are smaller than user surfaces but never cramped.
- Color is operational, not decorative: aqua for live activity, gold for settlement-ready/won, coral only for exceptions/errors, cobalt for the primary action in context. Status never by color alone.
- **No decorative charts.** A chart exists only if it answers a real operational question (e.g., settlement completion within deadline); it uses the brand palette and tabular axes.
- Money-touching and destructive operator actions use consequence-stating confirmations with the operator's identity shown on every audit-visible action (frozen TRD/brief rules).
- Desktop-first (≥ 1280 core target); mobile gets a read-only simplified queues view, not squeezed tables.

---

## 13. Motion System

Motion is part of the product identity — **subtle, fast, tactile**. It clarifies state and increases confidence; it never performs.

### Timing tokens
| Tier | Range | Use |
|---|---|---|
| Micro | **120–160 ms** | Button press/release, hover states, toggle switches, tab indicators |
| Standard | **200–280 ms** | Page/step transitions, list item enter/exit, sheet/dialog open-close, notification arrival |
| Major state transition | **300–400 ms** | Auction close, winner/result reveal, settlement completion, featured-auction crossfade |

- Easing: decisive ease-out for entrances (`cubic-bezier(0.22, 1, 0.36, 1)`), gentle ease-in-out for exits; soft spring for tactile press and bottom-sheet physics. No bounce on money surfaces.

### Motion moments (each with a defined behavior)
- Navigation (tab/route transitions), button hover/press, page transitions
- **Bid submission** → tactile press → brief submitting state → accepted/rejected state change
- **Accepted/rejected states** → single subtle highlight pulse + status line (icon + text + color)
- **Countdown transitions** → tabular digits swap without reflow; ending-soon state change is a calm transition, never flashing
- **Wallet updates** → balance arrives at final value (no count-up); the transaction row enters with a standard-timed slide
- **Notification arrival** → badge dot + one gentle standard-timed slide of the row
- **Auction closing** → calm transition to ended state
- **Winner/result reveal** → the one sanctioned "major" moment: gold emphasis, Fraunces headline where brand context allows, 300–400 ms entrance — earned, not confetti

### Prohibitions
No perpetual motion, no bouncing everything, no parallax, no decorative animation everywhere, no animated money values, no casino suspense loops.

### Reduced motion
Every animation has a `prefers-reduced-motion` equivalent: instant state changes with the same color/icon/text signals; nothing essential is conveyed by motion alone.

### Ecosystem note (for implementation)
Implementation uses the **current Motion ecosystem (`motion` / motion.dev APIs)**, not legacy `framer-motion` imports. Migrating the project's existing `framer-motion` usage is an implementation task; design timings above are library-independent.

---

## 14. Buttons & Controls

- **Primary CTA (cobalt):** visually strong, obvious, high contrast; **44 px+ touch target** (larger for the auction bid action); meaningful hover (slight lift/tint), focus (2 px ring, offset), pressed (scale ≤ 0.98 + darker tint), loading (inline spinner + label), and disabled (reduced contrast **with reason**, never a dead end).
- **Hierarchy:** primary (cobalt) → secondary (ink outline / surface) → tertiary (ghost/text). **Not every button is loud** — one primary action per screen region; the rest recede.
- **The main auction action gets the strongest visual emphasis in the product:** largest primary button, persistent placement (sticky on mobile), and the full state choreography of §15.
- Financial buttons (Deposit, Pay settlement, Withdraw) follow the same craft with receipt-first confirmations; destructive actions are coral, always consequence-labeled.
- Controls (inputs, chips, toggles, segmented controls, tabs): consistent 8–10 px radii, 1 px cool-neutral borders, cobalt focus, tactile press at micro timing.

---

## 15. Interaction States — Complete Matrix

Every interactive element defines **all** relevant states below, and **no state is ever conveyed by color alone** (always paired with icon, text, weight, or motion).

| State | Visual treatment (light) | Non-color channel |
|---|---|---|
| Hover | Subtle surface tint / border emphasis; cursor affordance | Underline or elevation shift; 120–160 ms |
| Focus (keyboard) | 2 px cobalt ring, visible offset — never suppressed | Ring; required for WCAG |
| Pressed | Scale ≤ 0.98, deeper tint | Micro-timing transform |
| Loading | Inline spinner replaces/changes label; control locked | Spinner + text ("Placing bid…"), aria-busy |
| Success | Aqua/gold accent + calm check | Icon + text ("Bid accepted") + one pulse |
| Error | Coral accent on the failing control + inline message | Icon + message text; linked via `aria-describedby` |
| Disabled | Reduced contrast | Reason text/tooltip — always says why |
| Selected | Cobalt border/fill tint | Check indicator + `aria-selected` |
| Live | Aqua badge + steady (not blinking) indicator | "LIVE" text + icon |
| Winner | Gold emphasis on the result module | "Winner" text + trophy/medal icon |
| Ending soon | Coral-tinted countdown chip within the final window (window length = configured parameter; while `[OPEN]`, the final-minute state only) | "Ending soon" label + hourglass icon |

---

## 16. Imagery & Illustration

- **No generic SaaS illustrations** (no abstract blob people, no isometric dashboards, no stock handshakes).
- **Premium product photography** is the primary imagery: studio-grade, single clear light source, deep-ink backdrops for dark-context crops and pearl/neutral backdrops for light-context crops; product fills the frame with breathing room.
- **Art-directed auction imagery:** consistent lighting, angle and framing across prize photos so the catalogue reads as one curated auction house — desirable, editorial, calm.
- **Restrained abstract lighting/depth:** soft vignettes and subtle gradients permitted for atmosphere on hero/brand stages only (§5 policy).
- **Small purposeful diagrams:** one monochrome-ink + cobalt diagram explains the LUBA mechanic (bids descend → duplicates eliminate → the lowest unique point wins) for rules sections and onboarding. Diagrams explain; they never decorate and never imply competitive data.
- Imagery treatment must hold in **both themes** (consistent crops, no theme-clashing skies/backgrounds), and must never depict gambling cues.

---

## 17. Responsive Design

**Mobile is first-class, not desktop squeezed down.** Compositions are intentionally designed per class:

- **Mobile (375 / 430 QA widths):** single column; bottom tab navigation; sticky bid/wallet action bars in the thumb zone; full-screen money flows; large inputs; every flow completable one-handed.
- **Tablet (768 QA width):** two-pane where it earns it (catalogue + preview, auction detail with persistent bid rail); bottom bar becomes a side rail or top-bar pattern without changing information architecture.
- **Desktop (1280 QA width):** full editorial composition — featured-auction hero, catalogue grids (2–4 columns), persistent navigation rail, dense Operations tables; no stretched full-bleed content (centered max-width containers).
- Primary QA widths: **375 · 430 · 768 · 1280**. All money/bid actions verified at all four.
- Breakpoint behavior never diverges in information architecture — the same content, recomposed.

---

## 18. Accessibility

- **Target: WCAG 2.2 AA** in both themes, EN and AM.
- Semantic HTML first; visible focus everywhere; full keyboard support (tab order = visual order; Escape closes overlays with focus return; skip-to-content).
- Strong contrast: all text ≥ 4.5:1, large text & UI edges ≥ 3:1 — verified per token pair in Pearl and Midnight (accent-on-foundation pairs checked explicitly, e.g., gold on Midnight, coral on Pearl).
- Meaningful states: §15 matrix; status by icon + text + color.
- **44 px+ targets for coarse pointers** (mobile and touch); ≥ 24 px spacing per WCAG 2.2 target-size rules.
- Reduced motion parity (§13).
- **Countdown a11y:** do **not** announce changing values every second; use `aria-live="polite"` with throttled boundary announcements (e.g., 10 min / 1 min) and a visually hidden raw timestamp.
- EN/AM typography quality: Noto Sans Ethiopic, Ethiopic line-height, no italics/letterspacing on Geez script, no truncation of financial/deadline copy (inherited brief rules §11 remain in force).

---

## 19. Design-Source Hierarchy

Generic design skills are **inputs, not authorities**. Order of application:

1. **Taste v2** — visual taste and anti-slop discipline (kills generic AI/slop aesthetics).
2. **UI/UX Pro Max** — structured design-system decisions (tokens, scales, component structure).
3. **Vercel Web Interface Guidelines** — interaction and accessibility quality bar.
4. **Taste Image-to-Code** — decomposition of references (e.g., the sign-in reference) into implementable structure, without copying.
5. **Awesome DESIGN.md** — design-system documentation structure for these docs.
6. **Motion Principles** — interaction motion craft (§13 is LUBA-tuned to its timing tiers).
7. **shadcn/Radix** — accessible component foundations (behavior, focus, ARIA); visuals re-skinned to PULSE.
8. **Phosphor** — icon direction: consistent stroke, geometric clarity, calm personality. Final icon dependency (Phosphor family vs. restyled Lucide) is decided at implementation; the *direction* is Phosphor's.
9. **Playwright** (later) — visual evidence and regression support for rendered QA.

**Override rule:** the LUBA design authority (this document) overrides generic aesthetic suggestions whenever they conflict.

---

## 20. Inheritance Rules for Downstream Documents

- **UI/UX Design Brief (`docs/luba-v1-ui-ux-design-brief.md`):** visual sections (§1 design system and any color/motion/palette references elsewhere) are **superseded by this authority** and require a revision pass to inherit PULSE. Behavioral/product sections (blind-bidding display rule, states, flows, anti-patterns of product truth) remain binding.
- **App Flow (future):** must compose PULSE surfaces with the flows of the brief; navigation and screen transitions use §13 timings.
- **Implementation Plan (future):** carries the implementation tasks implied here — font self-hosting (Manrope, Fraunces, Noto Sans Ethiopic, IBM Plex Mono), oklch token implementation for both themes, brand-mark artwork + variants + favicon set, Motion (`motion` package) adoption, icon-direction decision, imagery art direction, both-theme QA at 375/430/768/1280.
- Any future UI work that contradicts this document is a defect.

---

## 21. Open Design Decisions (not invented)

- **Live accepted-bid counter on auction surfaces:** TRD Open Question — **default OFF**; excluded from all designs until the owner decides.
- **Final color token values:** role table in §5 is binding; exact oklch values tuned and contrast-verified at implementation in both themes.
- **Final brand-mark artwork:** concept and construction rules are fixed (§7); drawn artwork and owner visual approval happen at implementation.
- **Amharic wordmark exploration (ሉባ):** optional exploration; not required for V1.
- **Fee/bounds display:** shown only once PRD values are frozen; no invented economics in any design.
- **Withdrawal UI:** honest "coming soon / being finalized" state until PRD parameters are decided.
- **Ending-soon window length:** uses the configured threshold once defined; until then only the final-minute state is designed.
- **Icon dependency (Phosphor vs. restyled Lucide):** implementation decision within the Phosphor direction (§19).

---

*End of Master Design Authority — LUBA PULSE (v2.0). No code has been written or modified in producing this document.*
