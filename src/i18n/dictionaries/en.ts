/**
 * English dictionary — the i18n source of truth.
 *
 * The shape of this object defines `TranslationKey`, so any key present here
 * must also exist in the Amharic dictionary for the app to typecheck
 * (compiler-enforced key parity). Flat, dot-keyed, typed: `t("shell.nav.home")`.
 */
export const en = {
  "shell.nav.home": "Home",
  "shell.nav.dashboard": "Dashboard",
  "shell.nav.skipToContent": "Skip to main content",
  "shell.nav.openMenu": "Open menu",
  "shell.nav.closeMenu": "Close menu",
  "shell.nav.siteMenu": "Site menu",
  "shell.nav.siteNavigation": "Site navigation",
  "shell.nav.loading": "Loading menu",
  "shell.nav.lubaHome": "LUBA home",
  "shell.brand.tagline": "Lowest unique bid wins",
  "shell.brand.statements": "Blind bidding. ETB wallet. Operator-curated prizes.",
  "shell.brand.footerStatement": "The lowest unique bid wins.",
  "shell.footer.home": "Home",
  "shell.footer.copyright": "© {year} LUBA",
  "shell.theme.toLight": "Switch to light theme",
  "shell.theme.toDark": "Switch to dark theme",
  "shell.action.signIn": "Sign in",
  "shell.action.signOut": "Sign out",
  "shell.language.toAmharic": "Switch to Amharic",
  "shell.language.toEnglish": "Switch to English",
} as const;

export type TranslationKey = keyof typeof en;
