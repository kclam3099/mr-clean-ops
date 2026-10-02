import { ZH } from "./zh";

/**
 * Interface language: English (default) or Simplified Chinese.
 *
 * The English text IS the key. `t("Dashboard")` returns "Dashboard" in English
 * and the dictionary entry in Chinese, so a string nobody has translated yet
 * still renders — in English — instead of as a raw key. Placeholders are
 * `{name}` and are filled from `vars` after the lookup, so a Chinese sentence
 * can put them in a different order.
 *
 * What is NEVER translated: customer and staff names, addresses, item
 * descriptions — anything a person typed — and the WhatsApp reminder, which is
 * sent to the customer in the language the business writes to them in.
 *
 * Isomorphic on purpose: no React and no `next/headers`, so the server reader
 * (lib/i18n/server.ts) and the client provider share one implementation.
 */
export type Lang = "en" | "zh";

export const LANG_COOKIE = "mcc_lang";

export function parseLang(value: string | null | undefined): Lang {
  return value === "zh" ? "zh" : "en";
}

export type Vars = Record<string, string | number>;
export type TFunc = (text: string, vars?: Vars) => string;

export function makeT(lang: Lang): TFunc {
  return (text, vars) => {
    let out = text;
    if (lang === "zh") {
      const hit = ZH[text];
      if (hit !== undefined) out = hit;
      else if (process.env.NODE_ENV !== "production") console.warn(`[i18n] missing zh: ${JSON.stringify(text)}`);
    }
    if (vars) {
      out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    }
    return out;
  };
}

/** The Intl locale for dates in this language. */
export function dateLocale(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-GB";
}
