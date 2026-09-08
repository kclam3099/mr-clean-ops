import type { AgendaAppointment } from "@/lib/agenda/queries";
import { AppointmentCard } from "./AppointmentCard";

/**
 * The one card layout the dashboard uses everywhere.
 *
 * Today and Tomorrow previously reached their cards by different routes —
 * Today through a grid of per-staff columns, Tomorrow through a single stacked
 * list — so one appointment rendered at a third of the width and the other at
 * full width. Same data, same density, wildly different cards.
 *
 * Grouping is now the caller's job and happens OUTSIDE this component, so a
 * staff heading can never change how wide a card is.
 */
export function AppointmentGrid({
  appointments,
  emptyMessage,
  showStaff = false,
  showWorkspace = false,
  detailHrefFor,
  highlightId,
}: {
  appointments: AgendaAppointment[];
  emptyMessage: string;
  showStaff?: boolean;
  showWorkspace?: boolean;
  detailHrefFor?: (id: string) => string;
  highlightId?: string;
}) {
  if (appointments.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    // One column on a phone, two from md, three on a very wide screen. A single
    // appointment therefore occupies a card-sized card rather than stretching
    // across the page.
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {appointments.map((a) => (
        <div
          key={a.id}
          className={`min-w-0 ${highlightId === a.id ? "rounded-xl ring-2 ring-slate-900 ring-offset-2" : ""}`}
        >
          <AppointmentCard
            appointment={a}
            showStaff={showStaff}
            showWorkspace={showWorkspace}
            detailHref={detailHrefFor?.(a.id)}
          />
        </div>
      ))}
    </div>
  );
}
