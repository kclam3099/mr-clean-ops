"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LANG_COOKIE } from "@/lib/i18n/core";
import { useT } from "./I18nProvider";

/**
 * Switches English ⇄ 中文 for this browser.
 *
 * A cookie rather than a URL segment: the language belongs to the person
 * holding the phone, not to a link — a Master pasting an appointment link to a
 * staff member should not switch the staff member's language. A refresh
 * re-renders every Server Component in the new language; nothing about the
 * session changes, so the full-document sign-out rule is unaffected.
 */
export function LanguageToggle({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const { lang } = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const next = lang === "zh" ? "en" : "zh";

  return (
    <button
      type="button"
      data-lang-toggle={next}
      disabled={pending}
      onClick={() => {
        document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        startTransition(() => router.refresh());
      }}
      aria-label={next === "zh" ? "切换到中文" : "Switch to English"}
      className={`flex min-h-9 shrink-0 cursor-pointer items-center rounded-lg px-2.5 text-sm font-semibold
                  transition-colors duration-200 disabled:opacity-60 ${
                    tone === "dark"
                      ? "bg-white/15 text-white hover:bg-white/25"
                      : "border border-line bg-card text-ink hover:bg-sunken"
                  }`}
    >
      {next === "zh" ? "中文" : "EN"}
    </button>
  );
}
