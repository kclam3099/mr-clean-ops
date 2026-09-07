import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope } from "@/lib/workspace/scope";
import { getMasterAgenda, businessToday, addDays } from "@/lib/agenda/queries";
import { AgendaList } from "@/components/agenda/AgendaList";
import { ErrorNotice } from "@/components/ui/ErrorNotice";

export const metadata = { title: "Appointments — Mr Clean & Clean Ops" };

/** Upcoming appointments as a flat agenda — the list counterpart to /calendar. */
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const today = businessToday();
  const result = await getMasterAgenda(session, scope, { from: today, to: addDays(today, 30) });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Appointments</h1>
        <p className="text-sm text-slate-500">{scope.label} · next 30 days</p>
      </div>

      {result.ok ? (
        <AgendaList
          appointments={result.appointments}
          emptyMessage="No appointments in the next 30 days."
          showStaff
          showWorkspace={scope.kind === "all"}
        />
      ) : (
        <ErrorNotice error={result.error} />
      )}
    </div>
  );
}
