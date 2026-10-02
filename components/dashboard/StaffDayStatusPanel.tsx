import type { StaffDayStatus, StaffDayState } from "@/lib/agenda/staff-status";
import { ACKNOWLEDGE_BY_HOUR } from "@/lib/agenda/staff-status";

/**
 * Who is up and has seen today's work.
 *
 * One tile per person, side by side, because the whole point is to answer
 * "is anyone not ready" in a glance rather than to be read line by line. The
 * earlier stacked list took a third of the first screen to say three words.
 *
 * Colour is never the only carrier. Each tile states its state in words as
 * well, because this is read at arm's length on a phone, in light that washes
 * a screen out, by people who may not separate red from green. A dot that is
 * the only difference between "ready" and "has not looked" is a dot that will
 * eventually be misread on a morning when it matters.
 */

const STATE: Record<
  StaffDayState,
  { tile: string; name: string; label: string; sub: string }
> = {
  seen: {
    tile: "border-ok/30 bg-ok/10",
    name: "text-ok",
    label: "Ready",
    sub: "text-ok/80",
  },
  unseen: {
    tile: "border-danger/35 bg-danger/10",
    name: "text-danger",
    label: "Not yet",
    sub: "text-danger/80",
  },
  none: {
    tile: "border-line bg-sunken",
    name: "text-ink-muted",
    label: "No jobs",
    sub: "text-ink-faint",
  },
};

export function StaffDayStatusPanel({ rows }: { rows: StaffDayStatus[] }) {
  if (rows.length === 0) return null;

  const waiting = rows.filter((r) => r.state === "unseen").length;

  return (
    <section
      aria-labelledby="staff-status-heading"
      data-staff-status
      className="rounded-2xl border border-line bg-card p-3 sm:p-4"
    >
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id="staff-status-heading" className="text-sm font-semibold text-ink">
          This morning
        </h2>
        <p className={`text-xs ${waiting ? "font-medium text-danger" : "text-ink-muted"}`}>
          {waiting === 0
            ? "Everyone with work today has seen it."
            : `${waiting} not ready`}
        </p>
      </div>

      {/* Equal columns, so three people read as one row at any width rather
          than reflowing into a ragged stack on a narrow phone. */}
      <ul
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.min(rows.length, 4)}, minmax(0, 1fr))` }}
      >
        {rows.map((r) => {
          const s = STATE[r.state];
          return (
            <li
              key={r.staffId}
              data-staff-status-row={r.name}
              data-state={r.state}
              className={`rounded-xl border px-2.5 py-2 text-center ${s.tile}`}
            >
              <span className={`block truncate text-sm font-bold ${s.name}`}>{r.name}</span>
              <span className={`mt-0.5 block text-[11px] font-semibold ${s.sub}`}>
                {s.label}
              </span>
              <span className="mt-0.5 block text-[10px] leading-tight text-ink-faint">
                {r.state === "none"
                  ? "—"
                  : r.acknowledgedAt
                    ? `${r.acknowledgedAt}${r.late ? " late" : ""}`
                    : `${r.appointments} job${r.appointments === 1 ? "" : "s"}`}
              </span>
            </li>
          );
        })}
      </ul>

      {rows.some((r) => r.late) ? (
        <p className="mt-2 text-[11px] text-warn">
          “late” means seen after {String(ACKNOWLEDGE_BY_HOUR).padStart(2, "0")}:00.
        </p>
      ) : null}
    </section>
  );
}
