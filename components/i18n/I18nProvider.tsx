"use client";

import { createContext, useContext, useMemo } from "react";
import { makeT, dateLocale, type Lang, type TFunc } from "@/lib/i18n/core";

const LangContext = createContext<Lang>("en");

/**
 * Hands the server-resolved language to Client Components. The root layout
 * reads the cookie once and passes it down, so the server render and the
 * client render can never disagree about which language they are in.
 */
export function I18nProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

/** `t` for a Client Component: `const { t, lang, locale } = useT();` */
export function useT(): { t: TFunc; lang: Lang; locale: string } {
  const lang = useContext(LangContext);
  return useMemo(() => ({ t: makeT(lang), lang, locale: dateLocale(lang) }), [lang]);
}
