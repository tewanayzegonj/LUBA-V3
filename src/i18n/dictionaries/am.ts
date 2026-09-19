import type { TranslationKey } from "./en";

/**
 * Amharic dictionary — አማርኛ.
 *
 * `satisfies Record<TranslationKey, string>` gives compiler-enforced key
 * parity with English: a key present in en.ts but missing here (or vice
 * versa, after a future key-type refactor) fails typecheck. Missing keys
 * cannot ship.
 *
 * Typography note: rendered in Noto Sans Ethiopic via html[lang="am"]
 * (index.css). Strings are functional language per the brief §11 rules.
 */
export const am: Record<TranslationKey, string> = {
  "shell.nav.home": "መነሻ",
  "shell.nav.dashboard": "ዳሽቦርድ",
  "shell.nav.skipToContent": "ወደ ዋናው ይዘት ዝለል",
  "shell.nav.openMenu": "ምናሌ ክፈት",
  "shell.nav.closeMenu": "ምናሌ ዝጋ",
  "shell.nav.siteMenu": "የጣቢያ ምናሌ",
  "shell.nav.siteNavigation": "የጣቢያ አሰሳ",
  "shell.nav.loading": "ምናሌ በመጫን ላይ",
  "shell.nav.lubaHome": "የLUBA መነሻ",
  "shell.brand.tagline": "ዝቅተኛው ልዩ ልመና አሸናፊ ነው",
  "shell.brand.statements": "የተደበቀ ልመና። ETB ዋሌት። በኦፕሬተር የተመረጡ ሽልማቶች።",
  "shell.brand.footerStatement": "ዝቅተኛው ልዩ ልመና አሸናፊ ነው።",
  "shell.footer.home": "መነሻ",
  "shell.footer.copyright": "© {year} LUBA",
  "shell.theme.toLight": "ወደ ብርሃናማ ገጽታ ቀይር",
  "shell.theme.toDark": "ወደ ጨለማ ገጽታ ቀይር",
  "shell.action.signIn": "ግባ",
  "shell.action.signOut": "ውጣ",
  "shell.language.toAmharic": "ወደ አማርኛ ቀይር",
  "shell.language.toEnglish": "ወደ እንግሊዝኛ ቀይር",
};
