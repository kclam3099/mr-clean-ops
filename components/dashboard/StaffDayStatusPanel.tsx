import type { StaffDayStatus, StaffDayState } from "@/lib/agenda/staff-status";
import { ACKNOWLEDGE_BY_HOUR } from "@/lib/agenda/staff-status";

/**
 * Who is up and has seen today's work.
 *
 * Colour is never the only carrier. Each row states its state in words as well,
 * because this is read at arm's length on a phone in a van, by people who may
 * not separate red from green, in light that washes a screen out. A dot that is
 * the only difference between "ready" and "has not looked" is a dot that will
 * eventually be misread on a morning when it matters.
 */

const STATE: Record<
  StaffDayState,
  { dot: string; chip: string; label: string; help: string }
> = {
  seen: {
    dot: "bg-ok",
    chip: "border-ok/30 bg-ok/10 text-ok",
    label: "Ready",
    help: "has seen today's jobs",
  },
  unseen: {
    dot: "bg-danger",
    chip: "border-danger/30 bg-danger/10 text-danger",
    label: "Not yet",
    help: "has not opened today's jobs",
  },
  none: {
    dot: "bg-ink-faint",
    chip: "border-line bg-sunken text-ink-muted",
    label: "No jobs",
    help: "nothing scheduled today",
  },
};

export function StaffDayStatusPanel({ rows }: { rows: StaffDayStatus[] }) {
  if (rows.length === 0) return null;

  const waiting = rows.filter((r) => r.state === "unseen").length;

  return (
    <section
      aria-labelledby="staff-status-heading"
      className="rounded-2xl border border-line bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="staff-status-heading" className="text-base font-semibold text-ink">
          This morning
        </h2>
        <p className="text-sm text-ink-muted">
          {waiting === 0
            ? "Everyone with work today has seen it."
            : `${waiting} ${waiting === 1 ? "person has" : "people have"} not looked yet.`}
        </p>
      </div>

      <ul className="mt-3 divide-y divide-line">
        {rows.map((r) => {
          const s = STATE[r.state];
          return (
            <li key={r.staffId} className="flex items-center gap-3 py-3">
              <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} />

              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{r.name}</span>
                <span className="block text-xs text-ink-muted">
                  {r.state === "none"
                    ? s.help
                    : r.appointments === 1
                      ? "1 job today"
                      : `${r.appointments} jobs today`}
                  {r.acknowledgedAt ? (
                    <>
                      {" · "}
                      seen {r.acknowledgedAt}
                      {r.late ? (
                        <span className="font-medium text-warn">
                          {" "}
                          (after {String(ACKNOWLEDGE_BY_HOUR).padStart(2, "0")}:00)
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </span>
              </span>

              <span
                className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${s.chip}`}
              >
                {s.label}
              </span>
              {/* The words above are the accessible label; the dot is decorative.
                  Repeating the state for screen readers would read it twice. */}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
