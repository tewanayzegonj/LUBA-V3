import { ThinkingOrb } from "thinking-orbs";
import type { OrbState, OrbSize, OrbTheme } from "thinking-orbs";

/**
 * LUBA wrapper around the official `thinking-orbs` component.
 *
 * Conventions (Master Design Authority — restrained, monochrome motion):
 *  - strictly monochrome ink; `theme="auto"` follows the app's light/dark
 *    class convention, so no LUBA accent colors are introduced;
 *  - only the two tuned presets ship: `64` for standalone loading states,
 *    `20` for inline loading — never an arbitrary scale;
 *  - generic indeterminate loading/working states ONLY — the orb never
 *    carries business-state semantics (auction, wallet, settlement…);
 *  - accessibility is the component's own (`role="img"`, per-state
 *    aria-label, prefers-reduced-motion static frame); pass `label` only
 *    to override with an i18n dictionary string.
 *
 * Performance (built into the component): offscreen and hidden-tab
 * instances pause; all instances share one clock. No custom animation
 * loop exists anywhere in this wrapper.
 */
export function LubaOrb({
  state = "working",
  size = 64,
  theme = "auto",
  label,
  className,
}: {
  state?: OrbState;
  size?: OrbSize;
  theme?: OrbTheme;
  /** Optional accessible-label override (i18n dictionary string). */
  label?: string;
  className?: string;
}) {
  return (
    <ThinkingOrb
      state={state}
      size={size}
      theme={theme}
      aria-label={label}
      className={className}
    />
  );
}
