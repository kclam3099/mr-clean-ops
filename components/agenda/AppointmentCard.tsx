import Link from "next/link";
import type { AgendaAppointment } from "@/lib/agenda/queries";
import { mapsHref, whatsappHref, whatsappChatHref, buildReminderMessage } from "@/lib/external-links";
import { colourAt, staffInitials } from "@/lib/agenda/staff-colour";
import {
  WhatsAppIcon, PhoneIcon, MapPinIcon, ClockIcon, MoneyIcon, StarIcon,
  CheckIcon, BanIcon,
} from "@/components/ui/icons";
import { getI18n } from "@/lib/i18n/server";
import type { TFunc } from "@/lib/i18n/core";

/**
 * The shared appointment card, used by both the Master calendar and the Staff
 * agenda.
 *
 * Field exposure is driven by props rather than by the data: RLS decides which
 * ROWS arrive, and these flags decide which FIELDS of an arriving row are
 * rendered for this surface.
 *
 * The time is the anchor. It used to be small mono text in the corner, which
 * meant the first thing the eye found on a day of work was a column of customer
 * names and the question "when" took a second pass. It now sits in its own
 * block down the left, at the largest size on the card, because the question
 * someone opens this screen to answer is what time they have to be somewhere.
 *
 * Two densities. `compact` is for the seven-column week grid, where a column is
 * roughly 170px: it drops the action buttons and the address so the customer
 * name has room to actually be read. The full card is for agenda lists, where
 * the row is wide and the actions are the point.
 */
export async function AppointmentCard({
  appointment: a,
  showStaff = false,
  showWorkspace = false,
  showAmount = true,
  compact = false,
  detailHref,
}: {
  appointment: AgendaAppointment;
  /** Master views list who the job is assigned to; a staff agenda is all "me". */
  showStaff?: boolean;
  /** Only meaningful in a merged multi-workspace view. */
  showWorkspace?: boolean;
  showAmount?: boolean;
  compact?: boolean;
  /** When given, the card body links through to the appointment detail. */
  detailHref?: string;
}) {
  const { t } = await getI18n();
  const maps = mapsHref(a.addressLine, a.areaCity);
  const whatsapp = whatsappHref(
    a.customerPhone,
    buildReminderMessage({ customerName: a.customerName, date: a.date, startTime: a.startTime }),
  );
  const chat = whatsappChatHref(a.customerPhone);
  const colour = colourAt(a.staffColourIndex);
  const cancelled = a.status === "cancelled";

  return (
    <article
      className={`overflow-hidden rounded-xl border border-l-4 border-line bg-card shadow-sm
                  transition-shadow duration-200 hover:shadow-md
                  ${colour.border} ${cancelled ? "opacity-70" : ""}`}
    >
      <CardLink href={detailHref}>
        <div className={`flex gap-3 ${compact ? "p-2.5" : "p-3.5"}`}>
          {/* ---- the time block: the reason this screen is open ---- */}
          <div
            className={`flex shrink-0 flex-col items-center justify-center rounded-lg
                        ${colour.bg} ${compact ? "min-w-14 px-1.5 py-1" : "min-w-16 px-2 py-1.5"}`}
          >
            <span
              className={`font-bold leading-none tabular-nums ${colour.text}
                          ${compact ? "text-sm" : "text-lg"}`}
            >
              {a.startTime}
            </span>
            <span
              className={`mt-0.5 leading-none tabular-nums text-ink-faint
                          ${compact ? "text-[9px]" : "text-[10px]"}`}
            >
              {a.endTime}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              {/* Wraps rather than truncating: the customer name is the single
                  most useful field and must stay readable in a narrow column. */}
              <h3
                className={`line-clamp-2 font-semibold leading-snug break-words text-ink
                            ${compact ? "text-sm" : "text-base"}
                            ${cancelled ? "line-through decoration-ink-faint" : ""}`}
              >
                {a.customerName}
              </h3>
              <StatusBadge status={a.status} compact={compact} t={t} />
            </div>

            {/* ---- the facts line: duration, money, large job ---- */}
            <div
              className={`mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1
                          ${compact ? "text-[11px]" : "text-xs"}`}
            >
              <span className="flex items-center gap-1 text-ink-muted">
                <ClockIcon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
                {t("{count}m", { count: a.durationMin })}
              </span>
              {showAmount && a.totalAmount !== null ? (
                <span className="flex items-center gap-1 font-semibold text-ink">
                  <MoneyIcon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
                  RM{a.totalAmount.toFixed(2)}
                </span>
              ) : null}
              {a.isLargeJob ? (
                <span className="flex items-center gap-1 rounded-full bg-amber/20 px-1.5 py-0.5 font-semibold text-warn">
                  <StarIcon className="h-3 w-3" />
                  {t("Large")}
                </span>
              ) : null}
            </div>

            {/* ---- where ---- */}
            {!compact && (a.addressLine || a.areaCity) ? (
              <p className="mt-1.5 flex items-start gap-1 text-sm text-ink-muted">
                <MapPinIcon className="mt-0.5 h-3.5 w-3.5 text-ink-faint" />
                <span className="min-w-0">{[a.addressLine, a.areaCity].filter(Boolean).join(", ")}</span>
              </p>
            ) : null}
            {compact && a.areaCity ? (
              <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-ink-faint">
                <MapPinIcon className="h-3 w-3" />
                {a.areaCity}
              </p>
            ) : null}

            {/* ---- who ---- */}
            {(showStaff && a.staffName) || (showWorkspace && a.workspaceName) ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {showStaff && a.staffName ? (
                  <span
                    className={`flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2
                                text-[11px] font-semibold ${colour.bg} ${colour.text}`}
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full
                                  text-[8px] font-bold text-white ${colour.solid}`}
                    >
                      {staffInitials(a.staffName)}
                    </span>
                    {a.staffName}
                  </span>
                ) : null}
                {showWorkspace && a.workspaceName ? (
                  <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                    {a.workspaceName}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </CardLink>

      {/* ---- actions, outside the link so a tap on one does not navigate ---- */}
      {!compact && (maps || a.customerPhone || whatsapp) ? (
        // Two by two on a phone: four buttons in one row overflow a 375px card.
        <div className="grid grid-cols-2 gap-1.5 border-t border-line bg-sunken/50 px-3.5 py-2 sm:flex">
          {whatsapp ? (
            // Branded on purpose: the glyph and the green are how someone knows
            // which app is about to open before they tap. Deep link only — it
            // opens WhatsApp with the message prefilled and is never sent
            // automatically; the user reviews and presses send.
            <a
              href={whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5
                         rounded-lg bg-[#25D366] px-2.5 text-xs font-semibold text-white
                         transition-colors duration-200 hover:bg-[#1da851]"
            >
              <WhatsAppIcon className="h-4 w-4" />
              {t("Reminder")}
            </a>
          ) : null}
          {chat ? (
            // Same app, nothing prefilled — just opens the chat.
            <a
              href={chat}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5
                         rounded-lg bg-[#25D366] px-2.5 text-xs font-semibold text-white
                         transition-colors duration-200 hover:bg-[#1da851]"
            >
              <WhatsAppIcon className="h-4 w-4" />
              WhatsApp
            </a>
          ) : null}
          {a.customerPhone ? (
            <a
              href={`tel:${a.customerPhone}`}
              className="flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5
                         rounded-lg border border-line bg-card px-2.5 text-xs font-semibold
                         text-ink transition-colors duration-200 hover:bg-sunken"
            >
              <PhoneIcon className="h-3.5 w-3.5 text-ok" />
              {t("Call")}
            </a>
          ) : null}
          {maps ? (
            <a
              href={maps}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5
                         rounded-lg border border-line bg-card px-2.5 text-xs font-semibold
                         text-ink transition-colors duration-200 hover:bg-sunken"
            >
              <MapPinIcon className="h-3.5 w-3.5 text-danger" />
              {t("Directions")}
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Makes the card body a link when a destination is given, and a plain wrapper
 * otherwise. Kept separate so the Directions and Call buttons stay outside the
 * link — nesting them would make a tap on either navigate instead.
 */
function CardLink({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <Link
      href={href}
      className="block outline-offset-2 focus-visible:outline focus-visible:outline-2
                 focus-visible:outline-brand-blue"
    >
      {children}
    </Link>
  );
}

function StatusBadge({
  status,
  compact,
  t,
}: {
  status: AgendaAppointment["status"];
  compact: boolean;
  t: TFunc;
}) {
  const styles: Record<AgendaAppointment["status"], { chip: string; label: string }> = {
    booked: { chip: "bg-brand/10 text-brand", label: t("Booked") },
    completed: { chip: "bg-ok/15 text-ok", label: t("Done") },
    cancelled: { chip: "bg-sunken text-ink-muted", label: t("Cancelled") },
  };
  const s = styles[status];

  if (compact) {
    // Colour PLUS a glyph. A coloured dot alone reads identically to anyone who
    // cannot separate those hues, and this is the field that says whether the
    // job is still happening.
    const glyph =
      status === "completed" ? <CheckIcon className="h-3 w-3" />
      : status === "cancelled" ? <BanIcon className="h-3 w-3" />
      : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />;
    return (
      <span
        title={s.label}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${s.chip}`}
      >
        {glyph}
        <span className="sr-only">{s.label}</span>
      </span>
    );
  }

  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.chip}`}
    >
      {s.label}
    </span>
  );
}
