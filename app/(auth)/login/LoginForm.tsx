"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signInAction, type LoginState } from "@/lib/auth/actions";
import { useT } from "@/components/i18n/I18nProvider";

const initial: LoginState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  const { t } = useT();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2
                 rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white
                 transition-colors duration-200 hover:bg-brand-700
                 active:bg-brand-900
                 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? (
        <>
          {/* Something has to move while the network is slow, or the second tap
              arrives and signs them in twice. */}
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
          {t("Signing in…")}
        </>
      ) : (
        t("Sign in")
      )}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState(signInAction, initial);
  const { t } = useT();

  // text-base, not text-sm, on both inputs. iOS zooms the whole page in when a
  // focused field is under 16px, and the way back out is a pinch the person has
  // to work out for themselves — on a phone held in one hand, outside, usually
  // in a hurry. The 2px it costs in visual tidiness is not a trade.
  const field =
    "min-h-12 w-full rounded-xl border border-line bg-white px-3.5 py-3 text-base text-ink " +
    "placeholder:text-ink-faint transition-colors duration-200 " +
    "focus:border-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-blue/30";

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="username" className="block text-sm font-semibold text-ink">
          {t("Username")}
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className={field}
          placeholder={t("e.g. JACK")}
        />
        {/* Said once, here, because the alternative is a support call: the
            field is not case sensitive and nobody should have to wonder. */}
        <p className="text-xs text-ink-muted">{t("Your name. Capitals do not matter.")}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-semibold text-ink">
          {t("Password")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={field}
        />
      </div>

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/5
                     px-3.5 py-3 text-sm font-medium text-danger"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            fill="currentColor"
            className="mt-0.5 h-4 w-4 shrink-0"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0v-3.5Zm0 6.5a.75.75 0 0 0-1.5 0v.5a.75.75 0 0 0 1.5 0v-.5Z"
              clipRule="evenodd"
            />
          </svg>
          {t(state.error)}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
