import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { getStaffAgenda, businessToday, singleDay } from "@/lib/agenda/queries";
import { AgendaList } from "@/components/agenda/AgendaList";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { AcknowledgeToday } from "@/components/agenda/AcknowledgeToday";
import { createClient } from "@/lib/supabase/serverClient";
import { formatDateHeading } from "@/components/agenda/AgendaList";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Today — Mr Clean & Clean Ops" };

export default async function TodayPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  const { t, locale } = await getI18n();

  const today = businessToday();
  const result = await getStaffAgenda(session, singleDay(today));

  // Whether this person has already confirmed today. Read through RLS like
  // everything else: the self-select policy returns their own row and nothing
  // else, so a staff member cannot probe anyone's morning but their own.
  let acknowledged = false;
  if (session.staffId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("staff_day_acknowledgements")
      .select("id")
      .eq("staff_id", session.staffId)
      .eq("ack_date", today)
      .maybeSingle();
    acknowledged = Boolean(data);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">{t("Today")}</h1>
          <p className="text-sm text-slate-500">{formatDateHeading(today, locale)}</p>
        </div>
        <Link
          href="/my/appointments/new?return=today"
          className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          {t("+ New")}
        </Link>
      </div>

      {/* Above the list, because it is the thing to do before leaving, and
          below the heading, because it is about what the list contains. */}
      {result.ok ? (
        <AcknowledgeToday
          jobCount={result.appointments.length}
          acknowledged={acknowledged}
        />
      ) : null}

      {result.ok ? (
        <AgendaList
          appointments={result.appointments}
          detailHrefFor={(id) => `/my/appointments/${id}`}
          emptyMessage={t("Nothing scheduled today.")}
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
