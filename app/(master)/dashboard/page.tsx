import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopeOptions, ALL_OPERATIONS } from "@/lib/workspace/scope";
import {
  getMasterAgenda, businessToday, monthGridRange, monthGridDays,
  monthKey, monthLabel, addMonths, sameMonth,
} from "@/lib/agenda/queries";
import { MonthOverview, type MonthEntry } from "@/components/dashboard/MonthOverview";
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
  searchParams: Promise<{ ws?: string; month?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;

  const today = businessToday();
  // A hand-edited or stale month falls back to this one rather than erroring.
  const anchor = /^\d{4}-\d{2}$/.test(params.month ?? "") ? `${params.month}-01` : today;
  const month = monthKey(anchor);

  // Exactly the cells the grid draws — six Sunday-anchored weeks — and nothing
  // beyond them. Paging a month forward is a new query for that grid, not a
  // speculative fetch of the rest of the year.
  const range = monthGridRange(anchor);
  const days = monthGridDays(anchor);

  const result = await getMasterAgenda(session, scope, range);

  const scopeValue = scope.kind === "workspace" ? scope.workspaceId : ALL_OPERATIONS;
  const monthHref = (m: string) => {
    const q = new URLSearchParams();
    if (hasChoice) q.set("ws", scopeValue);
    q.set("month", m);
    return `/dashboard?${q.toString()}`;
  };

  const heading = (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-slate-900">Dashboard</h1>
      {/* The subheading names the RESOLVED scope, and the selector in the nav
          reads the same URL parameter, so the two cannot disagree. */}
      <p className="text-sm text-slate-500" data-scope-label>
        {scope.label} · Month overview
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
    staffName: a.staffName,
    totalAmount: a.totalAmount,
    isLargeJob: a.isLargeJob,
  }));

  // Totals describe the MONTH, not the 42-day grid, so the leading and trailing
  // days visible from the neighbouring months do not inflate them. Computed
  // from rows this caller already received, never from a separate aggregate —
  // Nick and KC legitimately see different figures.
  const inMonth = entries.filter((e) => sameMonth(e.date, anchor));
  const revenue = inMonth.reduce((sum, e) => sum + (e.totalAmount ?? 0), 0);
  const largeJobs = inMonth.filter((e) => e.isLargeJob).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {heading}
        <Link
          href={hasChoice ? `/calendar?ws=${encodeURIComponent(scopeValue)}` : "/calendar"}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium
                     text-slate-700 transition hover:bg-slate-50"
        >
          Open calendar
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <Link
            href={monthHref(monthKey(today))}
            data-month-today
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            Today
          </Link>
          <Link
            href={monthHref(monthKey(addMonths(anchor, -1)))}
            data-month-prev
            aria-label="Previous month"
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm
                       text-slate-700 transition hover:bg-slate-50"
          >
            <span aria-hidden="true">←</span>
          </Link>
          <Link
            href={monthHref(monthKey(addMonths(anchor, 1)))}
            data-month-next
            aria-label="Next month"
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm
                       text-slate-700 transition hover:bg-slate-50"
          >
            <span aria-hidden="true">→</span>
          </Link>
          <h2 className="ml-1.5 text-base font-semibold tracking-tight text-slate-900" data-month-label>
            {monthLabel(anchor)}
          </h2>
        </div>

        <p className="text-xs text-slate-500" data-month-summary>
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

      <MonthOverview
        /* Remount on a month change: the selected day and any open popover
           belong to the month that was on screen, not the one arriving. */
        key={month}
        month={month}
        days={days}
        today={today}
        entries={entries}
        detailHrefBase="/appointments"
      />
    </div>
  );
}
