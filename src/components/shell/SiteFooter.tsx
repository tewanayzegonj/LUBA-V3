import { BrandLockup } from "@/components/brand/BrandMark";
import { Container } from "@/components/shell/PageShell";
import { useLanguage } from "@/i18n/use-language";
import { Link } from "react-router";

/**
 * SiteFooter — the LUBA global footer (MDA §3, brief §3).
 *
 * Brand-forward and deliberately restrained: lockup, a Fraunces brand line
 * (the sanctioned display moment for chrome), and an honest status line —
 * no invented nav columns or fake destinations (no About/Pricing/etc.,
 * which do not exist in the foundation). Links to existing routes only;
 * rows meet the 44px coarse-pointer minimum.
 */
export function SiteFooter() {
  const { t } = useLanguage();

  return (
    <footer className="border-t border-border/60 bg-card/40">
      <Container className="flex flex-col gap-6 py-10 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Link
            to="/"
            aria-label={t("shell.nav.lubaHome")}
            className="inline-flex h-11 w-fit items-center rounded-md"
          >
            <BrandLockup markSize={24} />
          </Link>
          <p className="font-display text-lg leading-snug text-foreground">
            {t("shell.brand.footerStatement")}
          </p>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            {t("shell.brand.statements")}
          </p>
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <Link
            to="/"
            className="inline-flex h-11 items-center rounded-md px-1 text-sm font-medium text-muted-foreground transition-micro hover:text-foreground"
          >
            {t("shell.footer.home")}
          </Link>
          <p className="text-xs text-muted-foreground">
            {t("shell.footer.copyright", { year: new Date().getFullYear() })}
          </p>
        </div>
      </Container>
    </footer>
  );
}
