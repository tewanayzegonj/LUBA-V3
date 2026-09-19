import { BrandLockup } from "@/components/brand/BrandMark";
import { LanguageToggle } from "@/components/shell/LanguageToggle";
import { Container } from "@/components/shell/PageShell";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/i18n/use-language";
import { Home, LayoutDashboard, LogIn, LogOut, Menu } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

/**
 * SiteHeader — the LUBA global navigation shell (MDA §3, brief §3).
 *
 * One sticky, blur-backed bar for every shell page. Navigation is visually
 * simple and intentional: brand (home) on the left; on desktop, exactly one
 * honest account action plus the language and theme toggles — no invented
 * nav links for destinations that do not exist yet. On mobile, the same
 * controls live in the header cluster with 44px+ targets (coarse-pointer
 * minimum) and the menu opens a controlled right-side sheet.
 *
 * All user-facing strings come from the typed i18n dictionary (EN/AM parity
 * enforced by the compiler). Auth states are honest (MDA §15): a neutral
 * skeleton while auth resolves — never a guessed signed-in/signed-out state.
 *
 * Motion: sheet slide is the built-in standard-timed transition; controls use
 * micro-timed hover/press feedback (transition-micro, scale ≤ 0.98). Reduced
 * motion collapses all of it via the global parity rule in index.css.
 */
export function SiteHeader() {
  const { isLoading, isAuthenticated, signOut } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const returnTo = `${location.pathname}${location.search}`;
  const authHref = `/auth?returnTo=${encodeURIComponent(returnTo)}`;

  const closeMenu = () => setMenuOpen(false);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error("Sign out error:", error);
    } finally {
      closeMenu();
      navigate("/");
    }
  };

  const mobileRowClass =
    "flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground transition-micro hover:bg-accent hover:text-accent-foreground active:scale-[0.99]";

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          to="/"
          aria-label={t("shell.nav.lubaHome")}
          className="inline-flex h-11 items-center rounded-md"
        >
          <BrandLockup markSize={24} />
        </Link>

        {/* Desktop cluster */}
        <div className="hidden items-center gap-2 md:flex">
          {isLoading ? (
            <span
              role="status"
              aria-label={t("shell.nav.loading")}
              className="size-9 animate-pulse rounded-md bg-muted"
            />
          ) : isAuthenticated ? (
            <Button
              asChild
              variant="outline"
              className="h-11 gap-2 rounded-md px-4 font-semibold transition-micro active:scale-[0.98]"
            >
              <Link to="/dashboard">
                <LayoutDashboard className="size-4" aria-hidden="true" />
                {t("shell.nav.dashboard")}
              </Link>
            </Button>
          ) : (
            <Button
              asChild
              variant="outline"
              className="h-11 gap-2 rounded-md px-4 font-semibold transition-micro active:scale-[0.98]"
            >
              <Link to={authHref}>
                <LogIn className="size-4" aria-hidden="true" />
                {t("shell.action.signIn")}
              </Link>
            </Button>
          )}
          <LanguageToggle />
          <ThemeToggle />
        </div>

        {/* Mobile cluster: language, theme, sheet menu (44px targets) */}
        <div className="flex items-center gap-1 md:hidden">
          <LanguageToggle />
          <ThemeToggle />
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("shell.nav.openMenu")}
                className="size-11 rounded-md text-muted-foreground transition-micro hover:bg-accent hover:text-accent-foreground active:scale-[0.98]"
              >
                <Menu className="size-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80 border-border/60">
              <SheetHeader className="border-b border-border/60 pb-4">
                <div className="flex items-center gap-2">
                  <BrandLockup markSize={22} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("shell.brand.tagline")}
                </p>
                {/* Dialog a11y names, visually carried by the lockup above */}
                <SheetTitle className="sr-only">{t("shell.nav.siteMenu")}</SheetTitle>
                <SheetDescription className="sr-only">
                  {t("shell.nav.siteNavigation")}
                </SheetDescription>
              </SheetHeader>
              <nav aria-label={t("shell.nav.siteNavigation")} className="flex flex-col gap-1 px-3 pt-3">
                <Link to="/" onClick={closeMenu} className={mobileRowClass}>
                  <Home className="size-4 text-muted-foreground" aria-hidden="true" />
                  {t("shell.nav.home")}
                </Link>
                {!isLoading && isAuthenticated && (
                  <Link
                    to="/dashboard"
                    onClick={closeMenu}
                    className={mobileRowClass}
                  >
                    <LayoutDashboard
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {t("shell.nav.dashboard")}
                  </Link>
                )}
              </nav>
              <div className="mt-auto flex flex-col gap-1 border-t border-border/60 p-3">
                {!isLoading &&
                  (isAuthenticated ? (
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className={`${mobileRowClass} text-destructive hover:bg-destructive/10 hover:text-destructive`}
                    >
                      <LogOut className="size-4" aria-hidden="true" />
                      {t("shell.action.signOut")}
                    </button>
                  ) : (
                    <Link to={authHref} onClick={closeMenu} className={mobileRowClass}>
                      <LogIn className="size-4 text-muted-foreground" aria-hidden="true" />
                      {t("shell.action.signIn")}
                    </Link>
                  ))}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </Container>
    </header>
  );
}
