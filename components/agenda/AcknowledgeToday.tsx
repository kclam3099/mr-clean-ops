"use client";

import { useState, useTransition } from "react";
import { acknowledgeTodayAction } from "@/lib/agenda/acknowledge-actions";
import { useT } from "@/components/i18n/I18nProvider";

/**
 * The staff-side half of the morning status.
 *
 * Shown only when there is work to acknowledge. A button that says "I have seen
 * today's jobs" on a day with no jobs trains people to tap it without looking,
 * which is the one thing that would make the Master's panel meaningless.
 */
export function AcknowledgeToday({
  jobCount,
  acknowledged,
}: {
  jobCount: number;
  acknowledged: boolean;
}) {
  const { t } = useT();
  const [done, setDone] = useState(acknowledged);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (jobCount === 0) return null;

  if (done) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-ok/25 bg-ok/5 px-3.5 py-3 text-sm font-medium text-ok">
        <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
        {t("Thanks — your manager can see you're ready today.")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await acknowledgeTodayAction();
            if (r.error) setError(r.error);
            else setDone(true);
          })
        }
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
          <>
            {jobCount === 1
              ? t("I've seen today's job")
              : t("I've seen today's {count} jobs", { count: jobCount })}
          </>
        )}
      </button>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
