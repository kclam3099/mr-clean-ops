import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopeOptions, ALL_OPERATIONS } from "@/lib/workspace/scope";
import {
  getMasterAgenda, businessToday, monthGridRange, monthGridDays,
  monthKey, monthLabel, addMonths, sameMonth,
  weekDays, dashWeekRange, weekLabel, weekStart, addDays,
} from "@/lib/agenda/queries";
import { MonthOverview, type MonthEntry } from "@/components/dashboard/MonthOverview";
import { StaffDayStatusPanel } from "@/components/dashboard/StaffDayStatusPanel";
import { getStaffDayStatus } from "@/lib/agenda/staff-status";
import { compactMoney } from "@/lib/pricing/duration";
import { ErrorNotice } from "@/components/ui/ErrorNotice";

export const metadata = { title: "Dashboard — Mr Clean & Clean Ops" };

/**
 * Master home: the month, at a glance.
 *
 * Logging in should answer "how full are we" in one look — which days are busy,
 * where the work clusters, which days are still open, where the big jobs are.
 * A month grid answers that; a list of the next fortnight did not, because you
 * could not see shape, only sequence.
 *
 * This is deliberately not /calendar. That page is a staff x day matrix for
 * deciding who does what on a given week. This one is month-shaped and
 * staff-labelled, and it hands off to the appointment for anything detailed.
 *
 * Everything comes from the same RLS-filtered read layer as the calendar, so a
 * Shared-Team-only Master's totals are computed from Shared-Team rows only —
 * there is no separate aggregate that could include what they cannot see.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; month?: string; range?: string; week?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;

  const today = businessToday();

  // Three ranges, because "how full are we" is a different question on a Monday
  // morning than at month end. An unrecognised value falls back to the month
  // rather than erroring, like every other hand-editable parameter here.
  const range: "week" | "next-week" | "month" =
    params.range === "week" || params.range === "next-week" ? params.range : "month";

  // A hand-edited or stale month falls back to this one rather than erroring.
  const anchor = /^\d{4}-\d{2}$/.test(params.month ?? "") ? `${params.month}-01` : today;
  const month = monthKey(anchor);

  // The week views anchor on an explicit date when one is given, so paging
  // forward from "next week" keeps working past the end of the month.
  const weekAnchor = /^\d{4}-\d{2}-\d{2}$/.test(params.week ?? "")
    ? (params.week as string)
    : range === "next-week" ? addDays(weekStart(today), 7) : today;

  // Exactly the cells the grid draws — six Monday-anchored weeks — and nothing
  // beyond them. Paging a month forward is a new query for that grid, not a
  // speculative fetch of the rest of the year.
  const isWeek = range !== "month";
  const queryRange = isWeek ? dashWeekRange(weekAnchor) : monthGridRange(anchor);
  const days = isWeek ? weekDays(weekAnchor) : monthGridDays(anchor);

  // Both reads are RLS-filtered and independent, so they go together rather
  // than making the morning panel wait for the month grid.
  const [result, dayStatus] = await Promise.all([
    getMasterAgenda(session, scope, queryRange),
    getStaffDayStatus(session, scope, today),
  ]);

  const scopeValue = scope.kind === "workspace" ? scope.workspaceId : ALL_OPERATIONS;
  const rangeHref = (r: "week" | "next-week" | "month", weekIso?: string) => {
    const q = new URLSearchParams();
    if (hasChoice) q.set("ws", scopeValue);
    if (r !== "month") {
      q.set("range", r);
      if (weekIso) q.set("week", weekIso);
    }
    return `/dashboard?${q.toString()}`;
  };

  const monthHref = (m: string) => {
    const q = new URLSearchParams();
    if (hasChoice) q.set("ws", scopeValue);
    q.set("month", m);
    return `/dashboard?${q.toString()}`;
  };

  const heading = (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Dashboard</h1>
      {/* The subheading names the RESOLVED scope, and the selector in the nav
          reads the same URL parameter, so the two cannot disagree. */}
      <p className="text-sm text-ink-muted" data-scope-label>
        {scope.label} · {isWeek ? "Week" : "Month"} overview
      </p>
    </div>
  );

  if (!result.ok) {
    return (
      <div className="space-y-5">
        {heading}
        <ErrorNotice error={result.error} />
      </div>
    );
  }

  // A compact projection: what a calendar entry draws and nothing else. The
  // month payload carries no address, phone or remarks, because no cell shows
  // them and the appointment page already does.
  const entries: MonthEntry[] = result.appointments.map((a) => ({
    id: a.id,
    date: a.date,
    startTime: a.startTime,
    customerName: a.customerName,
    staffId: a.staffId,
    staffName: a.staffName,
    staffColourIndex: a.staffColourIndex,
    totalAmount: a.totalAmount,
    isLargeJob: a.isLargeJob,
  }));

  // Totals describe the MONTH, not the 42-day grid, so the leading and trailing
  // days visible from the neighbouring months do not inflate them. Computed
  // from rows this caller already received, never from a separate aggregate —
  // Nick and KC legitimately see different figures.
  // For a week every visible day belongs to it, so there is nothing to exclude.
  // For a month the leading and trailing days of the neighbouring months are
  // drawn but must not inflate the totals.
  const inMonth = isWeek ? entries : entries.filter((e) => sameMonth(e.date, anchor));
  const revenue = inMonth.reduce((sum, e) => sum + (e.totalAmount ?? 0), 0);
  const largeJobs = inMonth.filter((e) => e.isLargeJob).length;

  const statusPanel = dayStatus.ok ? (
    <StaffDayStatusPanel rows={dayStatus.rows} />
  ) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {heading}
        <Link
          href={hasChoice ? `/calendar?ws=${encodeURIComponent(scopeValue)}` : "/calendar"}
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium
                     text-ink transition hover:bg-sunken"
        >
          Open calendar
        </Link>
      </div>

      {/* Range first, navigation second. Which span you are looking at is the
          bigger decision, and putting it on the same row as the arrows made
          "next" ambiguous — next week or next month? */}
      <div
        role="tablist"
        aria-label="Date range"
        data-range-tabs
        className="inline-flex rounded-xl border border-line bg-card p-0.5"
      >
        {([
          ["week", "This week", rangeHref("week")],
          ["next-week", "Next week", rangeHref("next-week")],
          ["month", "This month", rangeHref("month")],
        ] as const).map(([key, label, href]) => {
          const active = key === "month" ? !isWeek : range === key;
          return (
            <Link
              key={key}
              href={href}
              role="tab"
              aria-selected={active}
              data-range={key}
              data-active={active ? "true" : undefined}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-semibold
                          transition-colors duration-200 ${
                            active
                              ? "bg-brand text-white"
                              : "text-ink-muted hover:bg-sunken hover:text-ink"
                          }`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <Link
            href={isWeek ? rangeHref(range, weekStart(today)) : monthHref(monthKey(today))}
            data-month-today
            className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium
                       text-ink transition hover:bg-sunken"
          >
            Today
          </Link>
          <Link
            href={isWeek
              ? rangeHref(range, addDays(weekStart(weekAnchor), -7))
              : monthHref(monthKey(addMonths(anchor, -1)))}
            data-month-prev
            aria-label={isWeek ? "Previous week" : "Previous month"}
            className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm
                       text-ink transition hover:bg-sunken"
          >
            <span aria-hidden="true">←</span>
          </Link>
          <Link
            href={isWeek
              ? rangeHref(range, addDays(weekStart(weekAnchor), 7))
              : monthHref(monthKey(addMonths(anchor, 1)))}
            data-month-next
            aria-label={isWeek ? "Next week" : "Next month"}
            className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm
                       text-ink transition hover:bg-sunken"
          >
            <span aria-hidden="true">→</span>
          </Link>
          <h2 className="ml-1.5 text-base font-semibold tracking-tight text-ink" data-month-label>
            {isWeek ? weekLabel(weekAnchor) : monthLabel(anchor)}
          </h2>
        </div>

        <p className="text-xs text-ink-muted" data-month-summary>
          <span className="tabular-nums">{inMonth.length}</span>
          {inMonth.length === 1 ? " appointment" : " appointments"}
          {" · "}
          <span className="tabular-nums">{compactMoney(revenue)}</span>
          {largeJobs > 0 ? (
            <>
              {" · "}
              <span className="tabular-nums">{largeJobs}</span>
              {largeJobs === 1 ? " large job" : " large jobs"}
            </>
          ) : null}
        </p>
      </div>

      {/* First thing on the page: who is up and has seen today's work.
          The month is the context; this is the thing that needs acting on. */}
      {statusPanel}

      <MonthOverview
        /* Remount on a month change: the selected day and any open popover
           belong to the month that was on screen, not the one arriving. */
        key={isWeek ? `week-${weekStart(weekAnchor)}` : month}
        month={month}
        days={days}
        today={today}
        entries={entries}
        detailHrefBase="/appointments"
      />
    </div>
  );
}
