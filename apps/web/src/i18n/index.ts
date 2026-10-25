import { LANGUAGES, type Language } from "@keeman/core";
import { createI18n } from "vue-i18n";
import { loadLocale, saveLocale } from "../storage";
import de from "./de";
import en from "./en";

export const messages = { de, en };

/** Before unlock: stored choice, then the browser languages, then German. */
export function initialLocale(): Language {
  const stored = loadLocale();
  if (stored) return stored;
  for (const tag of navigator.languages) {
    const base = tag.toLowerCase().split("-")[0];
    const found = LANGUAGES.find((language) => language === base);
    if (found) return found;
  }
  return "de";
}

export const i18n = createI18n({
  legacy: false,
  locale: "de",
  fallbackLocale: "de",
  messages,
});

export function currentLocale(): Language {
  return i18n.global.locale.value;
}

export function setLocale(locale: Language, remember = true): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  if (remember) saveLocale(locale);
}
