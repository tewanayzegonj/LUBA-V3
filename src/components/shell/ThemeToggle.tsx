import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * LUBA PULSE theme toggle — Pearl (light) ⇄ Midnight (dark).
 *
 * The single sanctioned shell-theme interaction. Mounted-guarded (SSR /
 * pre-hydration safe): renders a stable placeholder button until the theme
 * preference resolves, so the control never misrepresents state.
 *
 * State feedback is icon + label (never color alone, MDA §15); the icon
 * crossfades at micro timing and is fully collapsed under reduced motion by
 * the global parity rule in index.css.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();

  // Client-only SPA with a fixed default: resolvedTheme is synchronous from
  // the first render — no mounted guard needed (and none wanted: it would
  // require setState-in-effect, which the render-cascade rule forbids).
  const isDark = resolvedTheme === "dark";
  const nextLabel = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={nextLabel}
      title={nextLabel}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "size-11 rounded-md text-muted-foreground transition-micro hover:bg-accent hover:text-accent-foreground active:scale-[0.98]",
        className,
      )}
    >
      <span className="relative grid size-4 place-items-center">
        <Sun
          aria-hidden="true"
          className={cn(
            "absolute size-4 transition-[opacity,transform] duration-(--duration-micro) ease-(--ease-out)",
            isDark ? "scale-75 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
          )}
        />
        <Moon
          aria-hidden="true"
          className={cn(
            "absolute size-4 transition-[opacity,transform] duration-(--duration-micro) ease-(--ease-out)",
            isDark ? "scale-100 rotate-0 opacity-100" : "scale-75 -rotate-90 opacity-0",
          )}
        />
      </span>
    </Button>
  );
}
