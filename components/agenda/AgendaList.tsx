import { groupByDate, type AgendaAppointment } from "@/lib/agenda/queries";
import { AppointmentCard } from "./AppointmentCard";

/**
 * Date-grouped agenda list. This is the primary mobile/staff presentation —
 * scannable cards rather than a compressed desktop calendar grid.
 */
export function AgendaList({
  appointments,
  emptyMessage = "Nothing scheduled.",
  showStaff = false,
  showWorkspace = false,
  showAmount = true,
  showDateHeadings = true,
}: {
  appointments: AgendaAppointment[];
  emptyMessage?: string;
  showStaff?: boolean;
  showWorkspace?: boolean;
  showAmount?: boolean;
  showDateHeadings?: boolean;
}) {
  if (appointments.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
        {emptyMessage}
      </p>
    );
  }

  const groups = groupByDate(appointments);

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.date} className="space-y-3">
          {showDateHeadings ? (
            <h2 className="sticky top-0 bg-slate-50/95 py-1 text-sm font-semibold text-slate-700 backdrop-blur">
              {formatDateHeading(g.date)}
            </h2>
          ) : null}
          <div className="space-y-3">
            {g.items.map((a) => (
              <AppointmentCard
                key={a.id}
                appointment={a}
                showStaff={showStaff}
                showWorkspace={showWorkspace}
                showAmount={showAmount}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function formatDateHeading(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}
