import { LanguageContext, type I18nContextValue } from "./language-context";
import { useContext } from "react";

/**
 * useLanguage — access the i18n runtime: `language`, `setLanguage`,
 * `toggleLanguage`, and the typed `t()` translator.
 *
 * Throws if used outside LanguageProvider (shell components are wrapped at
 * the root, so this only fires on genuine wiring mistakes).
 */
export function useLanguage(): I18nContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}
