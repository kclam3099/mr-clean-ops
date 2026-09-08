import Link from "next/link";
import type { AgendaAppointment, DateRange } from "@/lib/agenda/queries";
import { addDays } from "@/lib/agenda/queries";
import { AppointmentCard } from "./AppointmentCard";
import { formatDateHeading } from "./AgendaList";
import type { CalendarStaff } from "./StaffWeekGrid";

/**
 * Mobile calendar — a day strip plus that day's agenda, grouped by staff.
 *
 * A three-by-seven matrix cannot survive a 390px viewport, so the week becomes
 * a picker and the day becomes a list. The picker is plain links rather than
 * client state: server-rendered, keyboard navigable, no hydration cost.
 *
 * Same honesty rule as the desktop grid — a staff member with nothing listed is
 * shown as "Nothing scheduled", never as free or available.
 */
export function CalendarDayView({
  appointments,
  staff,
  range,
  selectedDay,
  today,
  hrefForDay,
  newHrefFor,
  detailHrefFor,
  showWorkspace = false,
  highlightId,
}: {
  appointments: AgendaAppointment[];
  staff: CalendarStaff[];
  range: DateRange;
  selectedDay: string;
  today: string;
  hrefForDay: (date: string) => string;
  newHrefFor: (staffId: string, date: string) => string;
  detailHrefFor: (id: string) => string;
  showWorkspace?: boolean;
  highlightId?: string;
}) {
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);

  const onDay = appointments.filter((a) => a.date === selectedDay);
  const hasAny = new Set(appointments.map((a) => a.date));

  return (
    <div className="space-y-4">
      <nav aria-label="Day of week" className="-mx-1 overflow-x-auto">
        <ul className="flex gap-1 px-1">
          {days.map((date) => {
            const selected = date === selectedDay;
            return (
              <li key={date} className="flex-1">
                <Link
                  href={hrefForDay(date)}
                  aria-current={selected ? "date" : undefined}
                  className={`flex min-h-14 min-w-12 flex-col items-center justify-center rounded-xl border
                              px-2 py-1.5 text-center transition ${
                    selected
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                  } ${date === today && !selected ? "ring-1 ring-slate-900" : ""}`}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                    {new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })
                      .format(new Date(`${date}T00:00:00Z`))}
                  </span>
                  <span className="text-base font-medium tabular-nums">{Number(date.split("-")[2])}</span>
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 h-1 w-1 rounded-full ${
                      hasAny.has(date) ? (selected ? "bg-white" : "bg-slate-900") : "bg-transparent"
                    }`}
                  />
                  <span className="sr-only">
                    {hasAny.has(date) ? "has appointments" : "no appointments visible"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <h2 className="text-sm font-semibold text-slate-900">
        {formatDateHeading(selectedDay)}
        {selectedDay === today ? (
          <span className="ml-2 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
            Today
          </span>
        ) : null}
      </h2>

      <div className="space-y-5">
        {staff.map((member) => {
          const items = onDay.filter((a) => a.staffId === member.id);
          return (
            <section key={member.id} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {member.name}
              </h3>
              {items.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm text-slate-500">Nothing scheduled.</p>
                  <Link
                    href={newHrefFor(member.id, selectedDay)}
                    className="flex min-h-11 items-center justify-center rounded-xl border border-dashed
                               border-slate-300 px-4 text-sm font-medium text-slate-600 transition
                               hover:border-slate-500 hover:text-slate-900"
                  >
                    + Book {member.name}
                  </Link>
                </div>
              ) : (
                items.map((a) => (
                  <div
                    key={a.id}
                    className={
                      highlightId === a.id ? "rounded-xl ring-2 ring-slate-900 ring-offset-2" : undefined
                    }
                  >
                    <AppointmentCard
                      appointment={a}
                      showWorkspace={showWorkspace}
                      detailHref={detailHrefFor(a.id)}
                    />
                  </div>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
