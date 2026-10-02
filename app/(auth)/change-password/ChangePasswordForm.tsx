"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { changePasswordAction, type PasswordState } from "@/lib/auth/password-actions";
import { useT } from "@/components/i18n/I18nProvider";

const initial: PasswordState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  const { t } = useT();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2
                 rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white
                 transition-colors duration-200 hover:bg-brand-700 active:bg-brand-900
                 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? (
        <>
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
          {t("Saving…")}
        </>
      ) : (
        t("Save password")
      )}
    </button>
  );
}

export function ChangePasswordForm() {
  const [state, formAction] = useActionState(changePasswordAction, initial);
  const { t } = useT();

  const field =
    "min-h-12 w-full rounded-xl border border-line bg-white px-3.5 py-3 text-base text-ink " +
    "placeholder:text-ink-faint transition-colors duration-200 " +
    "focus:border-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-blue/30";

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-semibold text-ink">
          {t("New password")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={field}
        />
        {/* The rule is stated before they can break it, not after. */}
        <p className="text-xs text-ink-muted">
          {t("At least 8 characters. Not your phone number.")}
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="confirm" className="block text-sm font-semibold text-ink">
          {t("Type it again")}
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={field}
        />
      </div>

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/5
                     px-3.5 py-3 text-sm font-medium text-danger"
        >
          <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0">
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
