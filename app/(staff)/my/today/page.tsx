import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getStaffAgenda, businessToday, singleDay } from "@/lib/agenda/queries";
import { AgendaList } from "@/components/agenda/AgendaList";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { formatDateHeading } from "@/components/agenda/AgendaList";

export const metadata = { title: "Today — Mr Clean & Clean Ops" };

export default async function TodayPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const today = businessToday();
  const result = await getStaffAgenda(session, singleDay(today));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Today</h1>
        <p className="text-sm text-slate-500">{formatDateHeading(today)}</p>
      </div>

      {result.ok ? (
        <AgendaList
          appointments={result.appointments}
          emptyMessage="Nothing scheduled today."
          showDateHeadings={false}
          // A merged identity-scoped agenda: every job is this person's own,
          // across every workspace they belong to. The workspace is shown only
          // when they actually belong to more than one.
          showWorkspace={session.workspaces.length > 1}
        />
      ) : (
        <ErrorNotice error={result.error} />
      )}
    </div>
  );
}
