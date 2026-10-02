import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopeOptions, ALL_OPERATIONS } from "@/lib/workspace/scope";
import { getMasterAgenda, businessToday, getStaffColourRanks } from "@/lib/agenda/queries";
import { getCalendarStaff } from "@/lib/agenda/staff";
import { RangeCalendar, resolveCalendar, toMonthEntries } from "@/components/dashboard/RangeCalendar";
import { StaffDayStatusPanel } from "@/components/dashboard/StaffDayStatusPanel";
import { getStaffDayStatus } from "@/lib/agenda/staff-status";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { getPendingLeaveForMaster } from "@/lib/leave/queries";
import { LeaveApprovalsPanel } from "@/components/leave/LeaveApprovalsPanel";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Dashboard — Mr Clean & Clean Ops" };

/**
 * Master home: this week by default, the month one tab away.
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
  const { t } = await getI18n();
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;

  const today = businessToday();
  // Lands on THIS WEEK: the first thing a Master acts on is the next few days.
  const cal = resolveCalendar(params, today);

  // All reads are RLS-filtered and independent, so they go together rather
  // than making the morning panel wait for the grid. The roster is the
  // calendar's own (the same RLS-visible set as Quick Add), so the day agenda
  // can list a person with nothing booked without ever listing someone this
  // Master cannot see.
  const [result, dayStatus, roster, colourRanks, pendingLeave] = await Promise.all([
    getMasterAgenda(session, scope, cal.queryRange),
    getStaffDayStatus(session, scope, today),
    getCalendarStaff(session, scope),
    getStaffColourRanks(),
    // RLS returns only people this Master manages: KC sees Victor, Nick does not.
    getPendingLeaveForMaster(session),
  ]);
  const staff = roster.map((s) => ({ ...s, colourIndex: colourRanks.get(s.id) ?? -1 }));

  const scopeValue = scope.kind === "workspace" ? scope.workspaceId : ALL_OPERATIONS;

  const heading = (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-ink">{t("Dashboard")}</h1>
      {/* The subheading names the RESOLVED scope, and the selector in the nav
          reads the same URL parameter, so the two cannot disagree. */}
      <p className="text-sm text-ink-muted" data-scope-label>
        {t(scope.label)} · {cal.isWeek ? t("Week overview") : t("Month overview")}
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {heading}
        <Link
          href={hasChoice ? `/calendar?ws=${encodeURIComponent(scopeValue)}` : "/calendar"}
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium
                     text-ink transition hover:bg-sunken"
        >
          {t("Open calendar")}
        </Link>
      </div>

      <RangeCalendar
        cal={cal}
        today={today}
        basePath="/dashboard"
        baseQuery={hasChoice ? { ws: scopeValue } : {}}
        entries={toMonthEntries(result.appointments)}
        staff={staff}
        detailHrefBase="/appointments"
        // Who is up and has seen today's work: the thing that needs acting on.
        beforeGrid={
          <>
            <LeaveApprovalsPanel requests={pendingLeave} />
            {dayStatus.ok ? <StaffDayStatusPanel rows={dayStatus.rows} /> : null}
          </>
        }
      />
    </div>
  );
}
