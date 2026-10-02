import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { getStaffAgenda, businessToday, singleDay, getStaffColourRanks } from "@/lib/agenda/queries";
import { RangeCalendar, resolveCalendar, toMonthEntries } from "@/components/dashboard/RangeCalendar";
import { AcknowledgeToday } from "@/components/agenda/AcknowledgeToday";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { createClient } from "@/lib/supabase/serverClient";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Calendar — Mr Clean & Clean Ops" };

/**
 * Staff home: the same week / month calendar a Master sees, with one
 * difference that matters — it holds this person's appointments and nobody
 * else's.
 *
 * That is enforced twice, neither time here in the UI: getStaffAgenda filters
 * on the session's own staff id, and the appointments_staff_select policy only
 * returns rows where `staff_id = my_staff_id()`. The roster handed to the day
 * agenda is just this person, so it cannot name a colleague either — not even
 * as "No appointment".
 */
export default async function StaffCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; range?: string; week?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.staffId) redirect("/");
  const staffId = session.staffId;

  const params = await searchParams;
  const { t } = await getI18n();
  const today = businessToday();
  const cal = resolveCalendar(params, today);

  const supabase = await createClient();
  const [result, todayResult, colourRanks, ack] = await Promise.all([
    getStaffAgenda(session, cal.queryRange),
    getStaffAgenda(session, singleDay(today)),
    getStaffColourRanks(),
    // Whether this person has already confirmed today, through RLS: the
    // self-select policy returns their own row and nothing else.
    supabase
      .from("staff_day_acknowledgements")
      .select("id")
      .eq("staff_id", staffId)
      .eq("ack_date", today)
      .maybeSingle(),
  ]);

  const heading = (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-ink">{t("My calendar")}</h1>
      <p className="text-sm text-ink-muted">
        {cal.isWeek ? t("Week overview") : t("Month overview")}
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

  const entries = toMonthEntries(result.appointments);
  const self = {
    id: staffId,
    // The staff display name, as every other surface shows it; the account
    // name only when there is nothing booked to read it from.
    name: result.appointments[0]?.staffName ?? session.fullName,
    colourIndex: colourRanks.get(staffId) ?? -1,
  };

  return (
    // data-wide: the staff shell is phone-width by default; a seven-column
    // grid needs the room on a tablet or desktop.
    <div className="space-y-4" data-wide>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {heading}
        <Link
          href="/my/appointments/new?return=mycalendar"
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          {t("+ New")}
        </Link>
      </div>

      <RangeCalendar
        cal={cal}
        today={today}
        basePath="/my/calendar"
        entries={entries}
        staff={[self]}
        detailHrefBase="/my/appointments"
        // The morning confirmation lives here too, now that this is where a
        // staff member lands — otherwise nobody would open Today to give it.
        beforeGrid={
          todayResult.ok ? (
            <AcknowledgeToday jobCount={todayResult.appointments.length} acknowledged={Boolean(ack.data)} />
          ) : null
        }
      />
    </div>
  );
}
