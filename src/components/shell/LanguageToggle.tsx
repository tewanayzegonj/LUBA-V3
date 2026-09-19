import { useLanguage } from "@/i18n/use-language";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * LanguageToggle — the ONE shell language control (brief §3.3, §11).
 *
 * Behavior contract:
 * - Displays the CURRENT language: "En" in English, "አማ" in Amharic.
 * - One tap switches immediately. No dropdown, no menu, no modal.
 * - The accessible name describes the TARGET ("Switch to Amharic"/
 *   "Switch to English") while the visible label shows the current language;
 *   aria-label overrides the inner text for assistive tech, so both rules
 *   hold without conflict.
 *
 * The label swap is a micro-timed crossfade (PULSE --duration-micro); reduced
 * motion collapses it via the global parity rule in index.css. "አማ" renders
 * in Noto Sans Ethiopic regardless of the active document language.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { language, toggleLanguage, t } = useLanguage();
  const isEnglish = language === "en";

  const actionLabel = isEnglish
    ? t("shell.language.toAmharic")
    : t("shell.language.toEnglish");

  const labelMotion =
    "absolute inset-0 grid place-items-center transition-[opacity,transform] duration-(--duration-micro) ease-(--ease-out)";

  return (
    <Button
      type="button"
      variant="outline"
      onClick={toggleLanguage}
      aria-label={actionLabel}
      title={actionLabel}
      className={cn(
        "h-11 min-w-11 rounded-md px-2 font-semibold transition-micro active:scale-[0.98]",
        className,
      )}
    >
      <span aria-hidden="true" className="relative block h-4 w-9">
        <span
          className={cn(
            labelMotion,
            "text-sm",
            isEnglish ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
          )}
        >
          En
        </span>
        <span
          style={{ fontFamily: "var(--font-ethiopic)" }}
          className={cn(
            labelMotion,
            "text-sm",
            isEnglish ? "opacity-0 -translate-y-1" : "opacity-100 translate-y-0",
          )}
        >
          አማ
        </span>
      </span>
    </Button>
  );
}
