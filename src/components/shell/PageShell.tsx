import { cn } from "@/lib/utils";
import { useLanguage } from "@/i18n/use-language";
import type { ReactNode } from "react";

/**
 * PageShell — the LUBA global layout primitive (MDA §17, brief §2).
 *
 * Composition: flex column, full viewport height; optional header slot →
 * scrollable `<main id="main">` (flex-1) → optional footer slot. The
 * sticky-footer pattern keeps short pages from floating content.
 *
 * Provides the two accessibility anchors every shell page inherits:
 * - the skip link as the first tab stop (WCAG 2.2, MDA §18)
 * - the single `<main>` landmark that receives focus after skipping
 *
 * Pages pass <SiteHeader /> and <SiteFooter /> explicitly and render only
 * content — no improvised layout scaffolding. Container (below) is the one
 * responsive width/gutter rhythm.
 */
export function PageShell({
  children,
  header,
  footer,
  className,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const { t } = useLanguage();

  return (
    <div
      className={cn(
        "flex min-h-svh flex-col bg-background text-foreground",
        className,
      )}
    >
      {/* Skip link: first tab stop on every shell page (WCAG 2.2, MDA §18) */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-lg"
      >
        {t("shell.nav.skipToContent")}
      </a>
      {header}
      <main
        id="main"
        tabIndex={-1}
        className="flex-1 focus:outline-none"
      >
        {children}
      </main>
      {footer}
    </div>
  );
}

/**
 * Container — the single responsive max-width rhythm for all pages
 * (centered max-width, no stretched full-bleed per MDA §17). Gutter grows
 * 16px (mobile, QA width 375) → 24px (sm) → 32px (lg). Pages render content.
 */
export function Container({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)}>
      {children}
    </div>
  );
}
