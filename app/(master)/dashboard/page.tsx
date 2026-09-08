import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopedHref, scopeOptions } from "@/lib/workspace/scope";
import { getMasterAgenda, businessToday, addDays, weekRange } from "@/lib/agenda/queries";
import { formatDateHeading } from "@/components/agenda/AgendaList";
import { WeekOverview } from "@/components/dashboard/WeekOverview";
import { ErrorNotice } from "@/components/ui/ErrorNotice";

export const metadata = { title: "Dashboard — Mr Clean & Clean Ops" };

/**
 * Master home: what is happening this week and next.
 *
 * The question on logging in is not "what is on today" but "what does the next
 * fortnight look like", so the page shows the rest of this week and all of next
 * as compact scannable rows. Detailed actions live on the appointment itself.
 *
 * Everything comes from the same RLS-filtered read layer as the calendar, so a
 * Shared-Team-only Master's totals are computed from Shared-Team rows only —
 * there is no separate aggregate that could include what they cannot see.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;

  const today = businessToday();
  // The rest of THIS week — earlier days are behind us and would only cost
  // vertical space — then the whole of next week.
  const thisWeek = { from: today, to: weekRange(today).to };
  const nextWeek = weekRange(addDays(weekRange(today).from, 7));

  const result = await getMasterAgenda(session, scope, { from: thisWeek.from, to: nextWeek.to });

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Dashboard</h1>
        <ErrorNotice error={result.error} />
      </div>
    );
  }

  const inRange = (from: string, to: string) =>
    result.appointments.filter((a) => a.date >= from && a.date <= to);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Dashboard</h1>
          {/* The heading names the RESOLVED scope, and the selector in the nav
              reads the same URL parameter, so the two cannot disagree. */}
          <p className="text-sm text-slate-500" data-scope-label>
            {scope.label} · {formatDateHeading(today)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={scopedHref("/calendar", scope, hasChoice)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            Open calendar
          </Link>
          <Link
            href={scopedHref("/appointments/new", scope, hasChoice)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            + New appointment
          </Link>
        </div>
      </div>

      <WeekOverview
        title="This week"
        range={thisWeek}
        appointments={inRange(thisWeek.from, thisWeek.to)}
        detailHrefFor={(id) => `/appointments/${id}`}
        emptyLabel="Nothing left this week."
      />

      <WeekOverview
        title="Next week"
        range={nextWeek}
        appointments={inRange(nextWeek.from, nextWeek.to)}
        detailHrefFor={(id) => `/appointments/${id}`}
        emptyLabel="Nothing booked next week yet."
      />
    </div>
  );
}
