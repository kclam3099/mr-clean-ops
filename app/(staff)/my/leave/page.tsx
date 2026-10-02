import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { businessToday } from "@/lib/agenda/queries";
import { getMyLeaveRequests } from "@/lib/leave/queries";
import { LeaveRequestForm } from "@/components/leave/LeaveRequestForm";
import { MyLeaveList } from "@/components/leave/MyLeaveList";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Leave — Mr Clean & Clean Ops" };

/**
 * Staff leave: ask for days off, see what was decided. Approval is a Master's,
 * on their dashboard; an approved request becomes time off and blocks bookings.
 */
export default async function StaffLeavePage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.staffId) redirect("/");

  const { t } = await getI18n();
  const { available, requests } = await getMyLeaveRequests(session);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{t("Leave")}</h1>
        <p className="text-sm text-ink-muted">{t("Apply for leave and see what was approved.")}</p>
      </div>

      {available ? (
        <>
          <LeaveRequestForm today={businessToday()} />
          <h2 className="pt-2 text-sm font-semibold text-ink">{t("My requests")}</h2>
          <MyLeaveList requests={requests} />
        </>
      ) : (
        <p className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
          {t("Leave requests are not switched on yet.")}
        </p>
      )}
    </div>
  );
}
