"use client";

import type { AppError } from "@/lib/errors/appError";
import { useT } from "@/components/i18n/I18nProvider";
import type { TFunc } from "@/lib/i18n/core";

/**
 * The only component that renders an error to a user.
 *
 * It accepts an already-mapped AppError and renders `error.message` — the safe
 * copy from the error module. It never accepts or renders raw server text, so
 * there is no path by which a PostgREST or RPC string reaches the DOM.
 *
 * `detail` is optional structured data the engine already decided this caller
 * may see; when a conflict is hidden from them the engine sends
 * STAFF_UNAVAILABLE with no detail at all, and this renders exactly that.
 *
 * A client component so it can translate at render: the message is one of the
 * fixed MESSAGES strings, which double as dictionary keys. Its props are plain
 * data, so Server Components render it too.
 */
export function ErrorNotice({ error }: { error: AppError }) {
  const { t } = useT();
  const detail = buildDetail(error, t);

  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <p className="font-medium">{t(error.message)}</p>
      {detail ? <p className="mt-1 text-amber-800">{detail}</p> : null}
    </div>
  );
}

function buildDetail(error: AppError, t: TFunc): string | null {
  const { blockingTime, windowStart, windowEnd } = error.detail;
  if (blockingTime) return t("Conflicting appointment starts at {time}.", { time: blockingTime });
  if (windowStart && windowEnd) return t("Working hours are {start}–{end}.", { start: windowStart, end: windowEnd });
  return null;
}
