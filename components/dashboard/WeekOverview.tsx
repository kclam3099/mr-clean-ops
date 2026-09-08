import Link from "next/link";
import type { AgendaAppointment } from "@/lib/agenda/queries";
import { addDays } from "@/lib/agenda/queries";
import { formatMoney } from "@/lib/pricing/duration";

/**
 * The dashboard's scan surface: two weeks of appointments as compact rows.
 *
 * The old dashboard used the full AppointmentCard — address, duration,
 * workspace badge, Directions, Call and WhatsApp on every appointment — which
 * made a single job about 200px tall and let roughly three fit on screen. That
 * is the wrong trade for a home page whose job is "what is happening over the
 * next fortnight". The detailed actions already live on the appointment itself,
 * so a row here carries only what you scan for and links through for the rest.
 *
 * Every total is computed from the rows this caller already received through
 * RLS. There is no separate aggregate query, so a Shared-Team-only Master's
 * figures are Shared-Team figures by construction — the DASH-02 lesson.
 */

export type WeekRange = { from: string; to: string };

export function WeekOverview({
  title,
  range,
  appointments,
  detailHrefFor,
  emptyLabel,
}: {
  title: string;
  range: WeekRange;
  appointments: AgendaAppointment[];
  detailHrefFor: (id: string) => string;
  /** Shown when the whole week is empty. */
  emptyLabel: string;
}) {
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);

  const byDate = new Map<string, AgendaAppointment[]>();
  for (const a of appointments) {
    const list = byDate.get(a.date);
    if (list) list.push(a);
    else byDate.set(a.date, [a]);
  }

  const total = sum(appointments);
  const largeJobs = appointments.filter((a) => a.isLargeJob).length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-300 pb-1.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</h2>
        <p className="text-sm tabular-nums text-slate-600">
          {appointments.length} appointment{appointments.length === 1 ? "" : "s"}
          {" · "}
          <span className="font-medium text-slate-800">{formatMoney(total)}</span>
          {/* Large jobs stay visible, but as a word in the summary rather than
              a card of their own. */}
          {largeJobs > 0 ? ` · ${largeJobs} large job${largeJobs === 1 ? "" : "s"}` : ""}
        </p>
      </div>

      {appointments.length === 0 ? (
        <p className="py-3 text-sm text-slate-500">{emptyLabel}</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {days.map((date) => (
            <DayGroup
              key={date}
              date={date}
              appointments={byDate.get(date) ?? []}
              detailHrefFor={detailHrefFor}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DayGroup({
  date, appointments, detailHrefFor,
}: {
  date: string;
  appointments: AgendaAppointment[];
  detailHrefFor: (id: string) => string;
}) {
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {dayHeading(date)}
        </h3>
        {appointments.length > 0 ? (
          <span className="text-xs tabular-nums text-slate-500">
            {appointments.length} · {formatMoney(sum(appointments))}
          </span>
        ) : null}
      </div>

      {appointments.length === 0 ? (
        // Compact, not a giant empty box: the owner still needs to see that the
        // day exists and is free.
        <p className="mt-0.5 text-sm text-slate-400">No appointments</p>
      ) : (
        <ul className="mt-1">
          {appointments.map((a) => (
            <li key={a.id}>
              <AppointmentRow appointment={a} href={detailHrefFor(a.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One appointment, one scannable line.
 *
 * Desktop lays the fields out in columns; below `sm` the same data stacks into
 * two lines rather than becoming a horizontally scrolling table.
 */
function AppointmentRow({ appointment: a, href }: { appointment: AgendaAppointment; href: string }) {
  return (
    <Link
      href={href}
      data-appointment-row
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5
                 text-sm transition hover:bg-slate-100 focus-visible:outline
                 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900"
    >
      <span className="w-12 shrink-0 font-mono tabular-nums text-slate-900">{a.startTime}</span>

      <span className="min-w-0 flex-1 basis-40 truncate font-medium text-slate-900">
        {a.customerName}
      </span>

      <span className="w-24 shrink-0 truncate text-slate-600 max-sm:order-3 max-sm:w-auto">
        {a.staffName ?? "Unassigned"}
      </span>

      {/* Area only — the full address belongs on the appointment itself. */}
      <span className="w-36 shrink-0 truncate text-slate-500 max-sm:order-3 max-sm:w-auto">
        {a.areaCity ?? ""}
      </span>

      <span className="w-20 shrink-0 text-right tabular-nums text-slate-900 max-sm:order-2 max-sm:ml-auto">
        {a.totalAmount === null ? "" : formatMoney(a.totalAmount)}
      </span>

      <span className="shrink-0 max-sm:order-3">
        <StatusDot status={a.status} isLargeJob={a.isLargeJob} />
      </span>
    </Link>
  );
}

function StatusDot({
  status, isLargeJob,
}: {
  status: AgendaAppointment["status"];
  isLargeJob: boolean;
}) {
  // Colour plus a word: the status must not depend on hue alone.
  const styles: Record<AgendaAppointment["status"], string> = {
    booked: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-slate-100 text-slate-600",
  };
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${styles[status]}`}>
        {status}
      </span>
      {isLargeJob ? (
        <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs font-medium text-purple-800">
          Large
        </span>
      ) : null}
    </span>
  );
}

function sum(items: AgendaAppointment[]): number {
  return items.reduce((total, a) => total + (a.totalAmount ?? 0), 0);
}

function dayHeading(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(d).toUpperCase();
}
