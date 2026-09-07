import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopedHref, scopeOptions } from "@/lib/workspace/scope";
import {
  getMasterAgenda, businessToday, addDays, type AgendaAppointment,
} from "@/lib/agenda/queries";
import { AgendaList, formatDateHeading } from "@/components/agenda/AgendaList";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { formatMoney } from "@/lib/pricing/duration";

export const metadata = { title: "Dashboard — Mr Clean & Clean Ops" };

/**
 * Master operational dashboard: what is happening today and tomorrow, at a
 * glance, for the selected workspace scope.
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
  const tomorrow = addDays(today, 1);
  const result = await getMasterAgenda(session, scope, { from: today, to: tomorrow });

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Dashboard</h1>
        <ErrorNotice error={result.error} />
      </div>
    );
  }

  const todays = result.appointments.filter((a) => a.date === today);
  const tomorrows = result.appointments.filter((a) => a.date === tomorrow);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500">{scope.label} · {formatDateHeading(today)}</p>
        </div>
        <Link
          href={scopedHref("/appointments/new", scope, hasChoice)}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          + New appointment
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Today" value={String(todays.length)} sub={`${formatMoney(sum(todays))} booked`} />
        <Stat label="Tomorrow" value={String(tomorrows.length)} sub={`${formatMoney(sum(tomorrows))} booked`} />
        <Stat
          label="Large jobs today"
          value={String(todays.filter((a) => a.isLargeJob).length)}
          sub="hold the rest of the day"
        />
      </div>

      <ByStaff title="Today" appointments={todays} scope={scope} hasChoice={hasChoice} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Tomorrow</h2>
          {/* -my-2 keeps the header row the same height while the padding
              gives the link a thumb-sized tap area on a phone. */}
          <Link
            href={scopedHref("/calendar", scope, hasChoice)}
            className="-my-2 py-2 text-sm text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            Open calendar
          </Link>
        </div>
        <AgendaList
          appointments={tomorrows}
          detailHrefFor={(id) => `/appointments/${id}`}
          emptyMessage="Nothing scheduled tomorrow yet."
          showDateHeadings={false}
          showStaff
          showWorkspace={scope.kind === "all"}
        />
      </section>
    </div>
  );
}

function sum(items: AgendaAppointment[]): number {
  return items.reduce((total, a) => total + (a.totalAmount ?? 0), 0);
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      <p className="mt-0.5 text-sm text-slate-500">{sub}</p>
    </div>
  );
}

/**
 * Today grouped by the person doing the work — the question a Master actually
 * asks in the morning is "who is doing what", not "what is in date order".
 */
function ByStaff({
  title, appointments, scope, hasChoice,
}: {
  title: string;
  appointments: AgendaAppointment[];
  scope: ReturnType<typeof resolveScope>;
  hasChoice: boolean;
}) {
  const byStaff = new Map<string, AgendaAppointment[]>();
  for (const a of appointments) {
    const key = a.staffName ?? "Unassigned";
    const list = byStaff.get(key);
    if (list) list.push(a);
    else byStaff.set(key, [a]);
  }
  const groups = [...byStaff.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        <Link
          href={scopedHref("/appointments", scope, hasChoice)}
          className="-my-2 py-2 text-sm text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
        >
          All appointments
        </Link>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          Nothing scheduled today.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {groups.map(([staffName, list]) => (
            <div key={staffName} className="min-w-0 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="truncate text-sm font-medium text-slate-900">{staffName}</h3>
                <span className="shrink-0 text-xs tabular-nums text-slate-500">
                  {list.length} · {formatMoney(sum(list))}
                </span>
              </div>
              <AgendaList
                appointments={list}
                detailHrefFor={(id) => `/appointments/${id}`}
                emptyMessage="—"
                showDateHeadings={false}
                showWorkspace={scope.kind === "all"}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
