import { cn } from "@/lib/utils";

/**
 * LUBA brand foundation — "The Lowest Unique Point" (Master Design Authority §7).
 *
 * Concept: a descending pulse line — runs shorten as the drops steepen, then
 * the terminal plunge settles shallower and resolves into one solid gold
 * point: bids descend, duplicates eliminate, the lowest unique point wins.
 *
 * Construction: 24×24 geometric grid, uniform 2.5 stroke, round caps/joins.
 * Rhythm: top run 3.5 → mid run 2.5 (accelerating cadence); drops steepen
 * ~62° → ~65°; the terminal plunge settles to ~54° so the final kink — the
 * moment the descent resolves — stays legible. The dot (r 2.5, larger than
 * the stroke) is concentric with the final vertex so the stroke flows into
 * the point; ink is optically balanced in the frame and dip + dot survive
 * at 16 px favicon scale.
 *
 * Distinction: unlike symmetric heartbeat/"activity" library icons or
 * symmetric crypto marks, this trajectory is strictly monotonic — it only
 * descends, and it ends at exactly one point.
 *
 * Theming: brand variant uses PULSE semantic tokens (--primary cobalt stroke,
 * --winner gold dot), so Pearl and Midnight are the same authored asset —
 * no per-theme artwork. `variant="mono"` renders everything in currentColor
 * for ink-on-light / light-on-dark / single-color contexts.
 *
 * No animation: a brand mark is a fixed asset; interaction motion belongs to
 * controls, not identity. (Deliberate per MDA §13 restraint rules.)
 */

type BrandMarkProps = {
  /** Rendered width/height in px (square viewBox 24). */
  size?: number;
  /** "brand" = cobalt + gold (PULSE tokens, theme-aware); "mono" = currentColor. */
  variant?: "brand" | "mono";
  /** Accessible name when not decorative. */
  label?: string;
  /** Hide from assistive tech when the surrounding context already names LUBA. */
  decorative?: boolean;
  className?: string;
};

const PULSE_TRAJECTORY = "M3.5 4.5 H7 L9.5 9.25 H12 L14.5 14.5 L18.5 20";

export function BrandMark({
  size = 24,
  variant = "brand",
  label = "LUBA",
  decorative = false,
  className,
}: BrandMarkProps) {
  const mono = variant === "mono";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      className={cn("shrink-0", className)}
    >
      <path
        d={PULSE_TRAJECTORY}
        stroke={mono ? "currentColor" : "var(--primary)"}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The lowest unique point — concentric with the final vertex. */}
      <circle
        cx={18.5}
        cy={20}
        r={2.5}
        fill={mono ? "currentColor" : "var(--winner)"}
      />
    </svg>
  );
}

/**
 * LUBA wordmark — Manrope 800, tight tracking (MDA §7.3). The trailing gold
 * period echoes the mark's unique point; it is decorative and excluded from
 * the accessible name via aria-hidden so screen readers announce "LUBA".
 */
export function Wordmark({
  className,
  showPoint = true,
  style,
}: {
  className?: string;
  showPoint?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={style}
      className={cn(
        "font-sans uppercase leading-none text-foreground select-none",
        className ?? "font-extrabold tracking-tight",
      )}
    >
      LUBA
      {showPoint && (
        <span aria-hidden="true" className="text-winner">
          .
        </span>
      )}
    </span>
  );
}

/**
 * Horizontal mark + wordmark lockup for headers and marketing surfaces.
 * The mark is decorative here — the wordmark carries the name.
 * Optical sizing: wordmark cap height tracks the mark (0.78×) and the gap
 * scales with it, so the lockup holds its proportions at any nav size
 * (MDA §7.3 — optically balanced spacing at all sizes).
 */
export function BrandLockup({
  markSize = 22,
  wordmarkClassName,
  showPoint = true,
  className,
}: {
  markSize?: number;
  wordmarkClassName?: string;
  showPoint?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center select-none", className)}
      style={{ gap: Math.max(6, markSize * 0.32) }}
    >
      <BrandMark size={markSize} decorative />
      <Wordmark
        showPoint={showPoint}
        className={cn("font-extrabold", wordmarkClassName)}
        style={{ fontSize: Math.max(14, markSize * 0.78) }}
      />
    </span>
  );
}
