import type { AppError } from "@/lib/errors/appError";

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
 */
export function ErrorNotice({ error }: { error: AppError }) {
  const detail = buildDetail(error);

  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <p className="font-medium">{error.message}</p>
      {detail ? <p className="mt-1 text-amber-800">{detail}</p> : null}
    </div>
  );
}

function buildDetail(error: AppError): string | null {
  const { blockingTime, windowStart, windowEnd } = error.detail;
  if (blockingTime) return `Conflicting appointment starts at ${blockingTime}.`;
  if (windowStart && windowEnd) return `Working hours are ${windowStart}–${windowEnd}.`;
  return null;
}
