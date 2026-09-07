import type { AgendaAppointment, DateRange } from "@/lib/agenda/queries";
import { addDays, groupByDate } from "@/lib/agenda/queries";
import { AppointmentCard } from "./AppointmentCard";
import { formatDateHeading } from "./AgendaList";

/**
 * Desktop Master week view — seven day columns.
 *
 * Deliberately a column-per-day layout of the same cards rather than a
 * pixel-positioned time grid: it degrades to a readable single column on
 * narrow screens, and the same card component serves both surfaces.
 */
export function WeekCalendar({
  appointments,
  range,
  showWorkspace = false,
}: {
  appointments: AgendaAppointment[];
  range: DateRange;
  showWorkspace?: boolean;
}) {
  const byDate = new Map(groupByDate(appointments).map((g) => [g.date, g.items]));

  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {days.map((date) => {
        const items = byDate.get(date) ?? [];
        return (
          <section key={date} className="min-w-0 space-y-2">
            <h2 className="border-b border-slate-200 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {formatDateHeading(date)}
            </h2>
            {items.length === 0 ? (
              <p className="py-3 text-xs text-slate-400">—</p>
            ) : (
              <div className="space-y-2">
                {items.map((a) => (
                  <AppointmentCard
                    key={a.id}
                    appointment={a}
                    showStaff
                    showWorkspace={showWorkspace}
                    compact
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
