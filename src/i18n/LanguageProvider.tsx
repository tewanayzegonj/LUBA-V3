import {
  LanguageContext,
  LANGUAGE_STORAGE_KEY,
  type I18nContextValue,
  type Language,
} from "./language-context";
import { am } from "./dictionaries/am";
import { en, type TranslationKey } from "./dictionaries/en";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  en,
  am,
};

/** Initial language: persisted choice, else English (foundation default). */
function readInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "en" || stored === "am") return stored;
  } catch {
    /* storage unavailable — default to English */
  }
  return "en";
}

/**
 * LanguageProvider — the LUBA i18n runtime (EN/AM, brief §11, MDA §6).
 *
 * Persists the choice to localStorage (survives navigation and sessions),
 * keeps `document.documentElement.lang` in sync so the html[lang="am"]
 * typography rules (Noto Sans Ethiopic, relaxed line-height) apply globally,
 * and exposes the typed `t()` translator. A missing runtime lookup falls
 * back to the raw key — obvious in development, never silently blank.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readInitialLanguage);

  // Ethiopic typography (index.css html[lang="am"]) keys off the document
  // element; the initial value is already "en" from index.html.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — language still applies for this session */
    }
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguage(language === "en" ? "am" : "en");
  }, [language, setLanguage]);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => {
      let text: string = dictionaries[language][key] ?? key;
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.replace(`{${name}}`, String(value));
        }
      }
      return text;
    },
    [language],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, toggleLanguage, t }),
    [language, setLanguage, toggleLanguage, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export type { TranslationKey } from "./dictionaries/en";
