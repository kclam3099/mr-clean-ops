import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { LANG_COOKIE, makeT, parseLang, dateLocale, type Lang, type TFunc } from "./core";

/** The caller's interface language, from the cookie the language toggle sets. */
export const getLang = cache(async (): Promise<Lang> => {
  const store = await cookies();
  return parseLang(store.get(LANG_COOKIE)?.value);
});

/** `t` for a Server Component: `const { t, lang, locale } = await getI18n();` */
export async function getI18n(): Promise<{ t: TFunc; lang: Lang; locale: string }> {
  const lang = await getLang();
  return { t: makeT(lang), lang, locale: dateLocale(lang) };
}
