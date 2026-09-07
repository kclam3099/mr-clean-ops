import type { AgendaAppointment } from "@/lib/agenda/queries";

/**
 * The shared appointment card, used by both the Master calendar and the Staff
 * agenda.
 *
 * Field exposure is driven by props rather than by the data: RLS decides which
 * ROWS arrive, and these flags decide which FIELDS of an arriving row are
 * rendered for this surface. Slots for the Maps and WhatsApp actions are
 * present and wired for Maps; WhatsApp is a deep link only and lands with the
 * reminder step.
 *
 * Two densities. `compact` is for the seven-column week grid, where a column is
 * roughly 170px: it drops the action buttons and the address so the customer
 * name has room to actually be read. The full card is for agenda lists, where
 * the row is wide and the actions are the point.
 */
export function AppointmentCard({
  appointment: a,
  showStaff = false,
  showWorkspace = false,
  showAmount = true,
  compact = false,
}: {
  appointment: AgendaAppointment;
  /** Master views list who the job is assigned to; a staff agenda is all "me". */
  showStaff?: boolean;
  /** Only meaningful in a merged multi-workspace view. */
  showWorkspace?: boolean;
  showAmount?: boolean;
  compact?: boolean;
}) {
  const mapsHref = buildMapsHref(a);

  return (
    <article
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${compact ? "p-3" : "p-4"}`}
    >
      <div className="flex items-start justify-between gap-2">
        {/* tabular-nums + nowrap so a time range never breaks across lines */}
        <p
          className={`whitespace-nowrap font-mono font-medium tabular-nums text-slate-900 ${
            compact ? "text-xs" : "text-sm"
          }`}
        >
          {a.startTime}–{a.endTime}
        </p>
        <StatusBadge status={a.status} compact={compact} />
      </div>

      {/* Wraps to two lines rather than truncating: the customer name is the
          single most useful field on the card and must stay readable in a
          narrow week column. */}
      <h3
        className={`mt-1 line-clamp-2 font-medium leading-snug break-words text-slate-900 ${
          compact ? "text-sm" : "text-base"
        }`}
      >
        {a.customerName}
      </h3>

      {a.isLargeJob ? (
        <span className="mt-1.5 inline-block rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
          Large job
        </span>
      ) : null}

      {!compact && (a.addressLine || a.areaCity) ? (
        <p className="mt-2 text-sm text-slate-600">
          {[a.addressLine, a.areaCity].filter(Boolean).join(", ")}
        </p>
      ) : null}
      {compact && a.areaCity ? (
        <p className="mt-1 truncate text-xs text-slate-500">{a.areaCity}</p>
      ) : null}

      <div
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-500 ${
          compact ? "mt-1.5 text-xs" : "mt-3 text-sm"
        }`}
      >
        {showAmount && a.totalAmount !== null ? (
          <span className="font-medium text-slate-700">RM{a.totalAmount.toFixed(2)}</span>
        ) : null}
        <span>{a.durationMin} min</span>
      </div>

      {(showStaff && a.staffName) || (showWorkspace && a.workspaceName) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {showStaff && a.staffName ? (
            <span className="text-xs font-medium text-slate-600">{a.staffName}</span>
          ) : null}
          {showWorkspace && a.workspaceName ? (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
              {a.workspaceName}
            </span>
          ) : null}
        </div>
      ) : null}

      {!compact ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {mapsHref ? (
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700
                         transition hover:bg-slate-50"
            >
              Directions
            </a>
          ) : null}
          {a.customerPhone ? (
            <a
              href={`tel:${a.customerPhone}`}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700
                         transition hover:bg-slate-50"
            >
              Call
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge({
  status,
  compact,
}: {
  status: AgendaAppointment["status"];
  compact: boolean;
}) {
  const styles: Record<AgendaAppointment["status"], string> = {
    booked: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-slate-100 text-slate-600",
  };
  if (compact) {
    // A coloured dot carries the same information without eating the width the
    // customer name needs.
    const dot: Record<AgendaAppointment["status"], string> = {
      booked: "bg-blue-500",
      completed: "bg-green-500",
      cancelled: "bg-slate-400",
    };
    return (
      <span
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot[status]}`}
        title={status}
        aria-label={status}
      />
    );
  }
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function buildMapsHref(a: AgendaAppointment): string | null {
  const query = [a.addressLine, a.areaCity].filter(Boolean).join(", ");
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
