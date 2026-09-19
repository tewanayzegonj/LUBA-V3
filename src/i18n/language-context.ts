import { createContext } from "react";
import type { TranslationKey } from "./dictionaries/en";

export type Language = "en" | "am";

/** localStorage key persisting the language choice across sessions. */
export const LANGUAGE_STORAGE_KEY = "luba.language";

export type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
  /** Translate a key in the active language, with `{param}` interpolation. */
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
};

export const LanguageContext = createContext<I18nContextValue | null>(null);
