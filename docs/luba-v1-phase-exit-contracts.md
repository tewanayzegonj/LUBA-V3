# LUBA — Phase I Exit-Gate Contracts (API Evolution + PULSE Kit Prerequisite)

**Document status:** ACTIVE — planning/contract documentation only. No application code is redesigned by this document.

**Purpose:** Two small contract artifacts from the Phase I exit gate, kept beside the other planning documents:

1. The **API evolution rule** for LUBA's client contract.
2. The **PULSE component-kit prerequisite** — what the binding kit must cover before any new screen work continues.

---

## 1. API evolution rule (client contract)

LUBA's current client contract **is the generated Convex API surface** — the typed function arguments and return values exposed by `src/convex` public surfaces (`api.*`). It is contract-first by construction: argument and return shapes are machine-readable and enforced at compile time on both sides.

**Rule — evolution is additive-first:**

- Do **not** rename or retype existing function arguments.
- Do **not** rename or retype existing projection fields.
- New fields must be added as **optional** (`v.optional(...)`) where compatibility with existing clients matters, and omitted (never defaulted into existence) from old projections.
- Removed or behavior-changed fields require an explicit owner-approved contract change — never a silent edit.

**External HTTP API:** not currently justified. The Convex wire protocol serves all V1 clients. If an external HTTP API is later approved, it will receive an **explicit versioned contract** (e.g. `/v1` path prefix, machine-readable OpenAPI Description per OAS 3.2.1, which also supports `webhooks` and `securitySchemes` for signature-documented webhook ingress such as Chapa's).

**Webhook ingress note (future, Phase E scope):** for any genuine HTTP boundary, an OpenAPI Description is authored **before** implementation, because OpenAPI describes HTTP APIs.

---

## 2. PULSE component-kit prerequisite (binding)

Per `docs/luba-master-design-authority.md` (LUBA PULSE), a **binding component kit** is a prerequisite for all future screen work. No new screen is built until its primitives exist in the kit; one-off bespoke components in feature code are not allowed while a kit primitive covers the need.

The kit must define, at minimum, each of the following — and every item below is a **checklist gate** for kit completeness:

### 2.1 Buttons
- Variants: primary, secondary, destructive, ghost, link — with the PULSE primary reserved for money-positive actions.
- States: default, hover, active, focus-visible, loading (spinner + label retention), disabled.
- Sizes: `sm` / `md` / `lg` with a minimum 44px touch target on mobile compositions.

### 2.2 Inputs
- Text, numeric-with-suffix (currency ETB), textarea, select, OTP/code input.
- States: default, focus, filled, error (message slot), disabled, readonly.
- Labels always visible; placeholder is never a label substitute.
- Money inputs use integer-santim parsing at the boundary — display formatting only in the presentation layer.

### 2.3 Cards / surfaces
- Elevation scale (flat / raised / overlay) mapped to PULSE tokens.
- Auction card anatomy (blind-safe): status badge, countdown slot, prize image, entry-fee line — never uniqueness/ranking/distribution fields.
- Money-positive vs urgent (amber) vs destructive surface accents.

### 2.4 Navigation
- App shell: top bar (desktop) + bottom tab bar (mobile), route-active states.
- Back behavior, deep-link affordances, auth-gated entry points (`/auth?returnTo=…`).
- Focus order and keyboard reachability for every nav target.

### 2.5 Dialogs / sheets
- Modal dialog (desktop) and bottom sheet (mobile) as one responsive primitive.
- Focus trap, escape-to-close, aria-modal, destructive-action confirmation pattern.
- Receipt-first money flows: confirmations present the outcome and reference, never auto-dismiss.

### 2.6 Status indicators
- Closed status vocabulary mapped 1:1 from the backend contracts (auction lifecycle, bid transactional status, settlement status).
- Badge/quiet-alert/composition for: LIVE (amber), processing-result (expired-open), CLOSED, SETTLED, pending-settlement deadline states, refund states.
- Expired-open presentation: derived client-side (`status === OPEN && clientNow >= closeAt`) — never a persisted lifecycle state; bidding controls must render disabled in this condition.

### 2.7 Typography hierarchy
- PULSE type scale (display / title / body / caption) with optical tracking rules for numerals.
- Tabular numerals for all money and countdown values.
- Minimum readable sizes on mobile; no font-size below 12px for meaningful text.

### 2.8 Phosphor icon rule (new code)
- All new code uses **Phosphor icons** (`@phosphor-icons/react`).
- No new lucide-react imports in feature code; existing template/component-library usages are tolerated but never extended.
- Icon sizing from the type scale (16/20/24), always paired with accessible names.

### 2.9 Motion vocabulary
- Durations: 120ms (micro), 200ms (standard), 320ms (surface transitions); easing `ease-out` default.
- Allowed: fade, slide-up (sheets), scale (dialogs), countdown pulse (amber urgent only).
- Forbidden: motion on money values (amounts appear/disappear without count-ups), looping decorative animation near economic content, layout-shifting entrances.
- Respect `prefers-reduced-motion` globally.

### 2.10 Accessibility behavior
- WCAG 2.1 AA contrast on all PULSE token pairs (light + dark).
- Full keyboard operability; visible focus rings on every interactive element.
- Screen-reader labels for status changes (countdown, settlement, refund announcements via `aria-live="polite"`).
- Touch targets ≥44px; no color-only status distinction (icon or label always accompanies color).

### 2.11 Mobile / desktop composition
- Mobile-first single-column composition; desktop enhancement (multi-column, hover affordances) layered on top.
- Sticky money-action bars on mobile (bid/deposit/settle CTA) with safe-area insets.
- Breakpoints consistent with the existing Tailwind scale; no horizontal scroll at 360px.

### 2.12 Visual QA checklist (per screen, per kit primitive)
- [ ] Uses only kit primitives and PULSE tokens (no ad-hoc colors/shadows/radii)
- [ ] Light + dark mode both verified
- [ ] Blind-bidding boundaries hold (no uniqueness/ranking/distribution visible)
- [ ] Money formatting matches the frozen receipt-first rules
- [ ] Status vocabulary matches backend contracts exactly
- [ ] Keyboard + screen-reader pass complete
- [ ] 360px, 768px, 1280px compositions verified
- [ ] `prefers-reduced-motion` verified

---

**Scope note:** this document adds no product policy and resolves no OPEN decision. It records contract discipline (additive-first evolution) and the PULSE kit's required coverage so Phase II planning can reference a stable checklist.
