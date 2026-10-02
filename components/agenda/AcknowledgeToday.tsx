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
        // Red until tapped: it is the one thing on the page waiting on them,
        // and it must not read as just another brand-blue button. Once done it
        // turns into the green confirmation below.
        data-ack-pending
        className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2
                   rounded-xl bg-danger px-4 py-3 text-base font-semibold text-white
                   shadow-md shadow-danger/25 ring-2 ring-danger/30 ring-offset-2 ring-offset-surface
                   transition-colors duration-200 hover:bg-rose-800 active:bg-rose-900
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
            <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0">
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm0 10a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 10 15Z"
                clipRule="evenodd"
              />
            </svg>
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
