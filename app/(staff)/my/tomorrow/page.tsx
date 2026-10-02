import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getStaffAgenda, businessToday, addDays, singleDay } from "@/lib/agenda/queries";
import { AgendaList, formatDateHeading } from "@/components/agenda/AgendaList";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Tomorrow — Mr Clean & Clean Ops" };

export default async function TomorrowPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  const { t, locale } = await getI18n();

  const tomorrow = addDays(businessToday(), 1);
  const result = await getStaffAgenda(session, singleDay(tomorrow));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">{t("Tomorrow")}</h1>
        <p className="text-sm text-slate-500">{formatDateHeading(tomorrow, locale)}</p>
      </div>

      {result.ok ? (
        <AgendaList
          appointments={result.appointments}
          detailHrefFor={(id) => `/my/appointments/${id}`}
          emptyMessage={t("Nothing scheduled tomorrow.")}
          showDateHeadings={false}
          showWorkspace={session.workspaces.length > 1}
        />
      ) : (
        <ErrorNotice error={result.error} />
      )}
    </div>
  );
}
