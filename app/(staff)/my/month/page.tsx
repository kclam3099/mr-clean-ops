import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getStaffAgenda, businessToday, monthRange } from "@/lib/agenda/queries";
import { AgendaList } from "@/components/agenda/AgendaList";
import { ErrorNotice } from "@/components/ui/ErrorNotice";

export const metadata = { title: "This month — Mr Clean & Clean Ops" };

export default async function MonthPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const range = monthRange(businessToday());
  const result = await getStaffAgenda(session, range);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">This month</h1>
        <p className="text-sm text-slate-500">
          {result.ok ? `${result.appointments.length} appointment(s)` : " "}
        </p>
      </div>

      {result.ok ? (
        <AgendaList
          appointments={result.appointments}
          detailHrefFor={(id) => `/my/appointments/${id}`}
          emptyMessage="Nothing scheduled this month."
          showWorkspace={session.workspaces.length > 1}
        />
      ) : (
        <ErrorNotice error={result.error} />
      )}
    </div>
  );
}
