import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope } from "@/lib/workspace/scope";
import { getMasterAgenda, businessToday, weekRange, addDays } from "@/lib/agenda/queries";
import { WeekCalendar } from "@/components/agenda/WeekCalendar";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import Link from "next/link";

export const metadata = { title: "Calendar — Mr Clean & Clean Ops" };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; week?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const anchor = isIsoDate(params.week) ? (params.week as string) : businessToday();
  const range = weekRange(anchor);

  const result = await getMasterAgenda(session, scope, range);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Calendar</h1>
          <p className="text-sm text-slate-500">
            {scope.label} · week of {range.from}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/appointments/new?return=calendar${scope.kind === "workspace" ? `&ws=${scope.workspaceId}` : ""}`}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            + New appointment
          </Link>
          <WeekLink ws={params.ws} week={addDays(range.from, -7)} label="← Previous" />
          <WeekLink ws={params.ws} week={businessToday()} label="This week" />
          <WeekLink ws={params.ws} week={addDays(range.from, 7)} label="Next →" />
        </div>
      </div>

      {result.ok ? (
        <WeekCalendar
          appointments={result.appointments}
          range={range}
          // Only label the workspace when several are merged — in a single
          // workspace view the column would be the same value on every card.
          showWorkspace={scope.kind === "all"}
        />
      ) : (
        <ErrorNotice error={result.error} />
      )}
    </div>
  );
}

function WeekLink({ ws, week, label }: { ws?: string; week: string; label: string }) {
  const params = new URLSearchParams();
  if (ws) params.set("ws", ws);
  params.set("week", week);
  return (
    <Link
      href={`/calendar?${params.toString()}`}
      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
    >
      {label}
    </Link>
  );
}

function isIsoDate(v: string | undefined): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
