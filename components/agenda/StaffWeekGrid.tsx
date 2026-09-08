import Link from "next/link";
import type { AgendaAppointment, DateRange } from "@/lib/agenda/queries";
import { addDays } from "@/lib/agenda/queries";
import { AppointmentCard } from "./AppointmentCard";

export type CalendarStaff = { id: string; name: string };

/**
 * Master week view — staff as rows, days as columns.
 *
 * The question a Master actually asks in the morning is "who is free, and
 * when". A column-per-day layout makes that a scan-and-group task across every
 * card; a row per staff member makes an EMPTY CELL the answer.
 *
 * The honesty rule, and it is not negotiable: an empty cell means "no
 * appointment you can see", NOT "free". A staff member may hold an appointment
 * in a workspace this caller cannot see, which still physically blocks them.
 * That gap is the privacy model working correctly — closing it would disclose
 * the hidden job. So a cell is never labelled "Free" or "Available"; it shows a
 * neutral dash and an add affordance, and the authoritative answer comes from
 * find_available_slots() and ultimately from create_appointment().
 */
export function StaffWeekGrid({
  appointments,
  staff,
  range,
  today,
  showWorkspace = false,
  newHrefFor,
  detailHrefFor,
  highlightId,
}: {
  appointments: AgendaAppointment[];
  staff: CalendarStaff[];
  range: DateRange;
  today: string;
  showWorkspace?: boolean;
  /** Empty-cell booking link. Hints only — the form re-validates them. */
  newHrefFor: (staffId: string, date: string) => string;
  detailHrefFor: (id: string) => string;
  highlightId?: string;
}) {
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);

  // staffId|date -> appointments, so a cell lookup is a single map hit.
  const cells = new Map<string, AgendaAppointment[]>();
  for (const a of appointments) {
    if (!a.staffId) continue;
    const key = `${a.staffId}|${a.date}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(a);
    else cells.set(key, [a]);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] border-separate border-spacing-0">
        <caption className="sr-only">
          Appointments by team member for the week of {range.from}. An empty cell
          means no appointment is visible to you, not that the team member is free.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 w-28 bg-slate-50 px-2 pb-2 text-left text-xs
                                       font-semibold uppercase tracking-wide text-slate-500">
              Team
            </th>
            {days.map((date) => (
              <th key={date} scope="col" className="px-1 pb-2 text-left align-bottom">
                <DayHeading date={date} isToday={date === today} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {staff.map((member) => (
            <tr key={member.id} className="align-top">
              <th scope="row" className="sticky left-0 z-10 border-t border-slate-200 bg-slate-50 px-2 py-3
                                         text-left text-sm font-medium text-slate-800">
                {member.name}
              </th>
              {days.map((date) => {
                const items = cells.get(`${member.id}|${date}`) ?? [];
                return (
                  <td
                    key={date}
                    className={`border-t border-slate-200 px-1 py-2 ${
                      date === today ? "bg-amber-50/60" : ""
                    }`}
                  >
                    {items.length === 0 ? (
                      <Link
                        href={newHrefFor(member.id, date)}
                        aria-label={`Book ${member.name} on ${date}`}
                        className="flex min-h-11 items-center justify-center rounded-lg border border-dashed
                                   border-slate-300 text-sm text-slate-400 transition hover:border-slate-500
                                   hover:text-slate-700 focus-visible:outline focus-visible:outline-2
                                   focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                      >
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">No appointment visible. Book this day.</span>
                      </Link>
                    ) : (
                      <div className="space-y-2">
                        {items.map((a) => (
                          <div
                            key={a.id}
                            className={
                              highlightId === a.id
                                ? "rounded-xl ring-2 ring-slate-900 ring-offset-2"
                                : undefined
                            }
                          >
                            <AppointmentCard
                              appointment={a}
                              showWorkspace={showWorkspace}
                              compact
                              detailHref={detailHrefFor(a.id)}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayHeading({ date, isToday }: { date: string; isToday: boolean }) {
  const [, month, day] = date.split("-");
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
  return (
    <span className="block">
      <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {weekday} {Number(day)}/{Number(month)}
      </span>
      {isToday ? (
        <span className="mt-0.5 inline-block rounded bg-slate-900 px-1.5 py-0.5 text-[10px]
                         font-semibold uppercase tracking-wide text-white">
          Today
        </span>
      ) : null}
    </span>
  );
}
