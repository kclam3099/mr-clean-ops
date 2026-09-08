import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopedHref, scopeOptions, ALL_OPERATIONS } from "@/lib/workspace/scope";
import { getMasterAgenda, businessToday, weekRange, addDays } from "@/lib/agenda/queries";
import { getCalendarStaff } from "@/lib/agenda/staff";
import { StaffWeekGrid } from "@/components/agenda/StaffWeekGrid";
import { CalendarDayView } from "@/components/agenda/CalendarDayView";
import { ErrorNotice } from "@/components/ui/ErrorNotice";

export const metadata = { title: "Calendar — Mr Clean & Clean Ops" };

/**
 * The Master's primary scheduling surface.
 *
 * Desktop is a staff x day matrix; mobile is a day picker plus that day's
 * agenda. The switch is CSS, not a client media query, so both are rendered
 * from the same server data with no hydration flash and no double fetch.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; week?: string; day?: string; new?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;
  const today = businessToday();
  const anchor = isIsoDate(params.week) ? (params.week as string) : today;
  const range = weekRange(anchor);

  const [result, staff] = await Promise.all([
    getMasterAgenda(session, scope, range),
    getCalendarStaff(session, scope),
  ]);

  // The selected mobile day must sit inside the week being shown, so a stale or
  // hand-edited value cannot point the agenda somewhere the grid is not.
  const requestedDay = isIsoDate(params.day) ? (params.day as string) : null;
  const selectedDay =
    requestedDay && requestedDay >= range.from && requestedDay <= range.to
      ? requestedDay
      : today >= range.from && today <= range.to
        ? today
        : range.from;

  const highlightId = isUuid(params.new) ? params.new : undefined;

  // Links carry the RESOLVED scope, never the raw parameter. `resolveScope`
  // silently drops a workspace this caller cannot see, so echoing the original
  // back would keep a rejected value alive in every subsequent link.
  const scopeValue = scope.kind === "workspace" ? scope.workspaceId : ALL_OPERATIONS;
  const keep = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    if (hasChoice) q.set("ws", scopeValue);
    if (params.week) q.set("week", params.week);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q.toString();
  };

  /** Booking hints for an empty cell. "All Operations" is virtual, so no
   *  workspace is passed from it — the form then requires a real one. */
  const newHrefFor = (staffId: string, date: string) => {
    const q = new URLSearchParams({ staff: staffId, date, return: "calendar" });
    if (scope.kind === "workspace") q.set("ws", scope.workspaceId);
    return `/appointments/new?${q.toString()}`;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Calendar</h1>
          <p className="text-sm text-slate-500">
            {formatRange(range.from, range.to)} · {scope.label}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={scopedHref("/availability", scope, hasChoice)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            Find a time
          </Link>
          <WeekLink query={keep({ week: addDays(range.from, -7) })} label="← Previous" />
          <WeekLink query={keep({ week: today })} label="This week" />
          <WeekLink query={keep({ week: addDays(range.from, 7) })} label="Next →" />
        </div>
      </div>

      {!result.ok ? (
        <ErrorNotice error={result.error} />
      ) : staff.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          No active team members in this view.
        </p>
      ) : (
        <>
          <div className="hidden lg:block">
            <StaffWeekGrid
              appointments={result.appointments}
              staff={staff}
              range={range}
              today={today}
              showWorkspace={scope.kind === "all"}
              newHrefFor={newHrefFor}
              detailHrefFor={(id) => `/appointments/${id}`}
              highlightId={highlightId}
            />
          </div>
          <div className="lg:hidden">
            <CalendarDayView
              appointments={result.appointments}
              staff={staff}
              range={range}
              selectedDay={selectedDay}
              today={today}
              hrefForDay={(date) => `/calendar?${keep({ day: date })}`}
              newHrefFor={newHrefFor}
              detailHrefFor={(id) => `/appointments/${id}`}
              showWorkspace={scope.kind === "all"}
              highlightId={highlightId}
            />
          </div>

          {/* States what an empty cell does and does not mean. A staff member
              may hold an appointment in a workspace you cannot see. */}
          <p className="text-xs text-slate-500">
            A blank day means no appointment is visible to you here. Use{" "}
            {/* -my-2 keeps the sentence on one line while the padding gives
                this inline link a thumb-sized hit area. */}
            <Link
              href={scopedHref("/availability", scope, hasChoice)}
              className="-my-2 inline-block py-2 underline"
            >
              Find a time
            </Link>{" "}
            to check what can actually be booked.
          </p>
        </>
      )}
    </div>
  );
}

function WeekLink({ query, label }: { query: string; label: string }) {
  return (
    <Link
      href={`/calendar?${query}`}
      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700
                 transition hover:bg-slate-50"
    >
      {label}
    </Link>
  );
}

function formatRange(from: string, to: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "short", timeZone: "UTC",
      ...(withYear ? { year: "numeric" } : {}),
    }).format(new Date(`${iso}T00:00:00Z`));
  return `${fmt(from, false)} – ${fmt(to, true)}`;
}

function isIsoDate(v: string | undefined): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isUuid(v: string | undefined): v is string {
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
}
