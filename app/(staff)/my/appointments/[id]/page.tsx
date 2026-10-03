import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { getAppointmentDetail, capabilitiesFor } from "@/lib/appointments/detail";
import { getBookingConfig } from "@/lib/booking-config/queries";
import { AppointmentDetailView } from "@/components/appointment-detail/AppointmentDetailView";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Appointment — Mr Clean & Clean Ops" };

/**
 * Staff appointment detail. Identity-scoped by RLS: the staff SELECT policy is
 * `staff_id = my_staff_id()`, so another person's appointment simply is not
 * returned — indistinguishable from one that does not exist.
 *
 * Whether Complete is offered comes from get_booking_config().staffCanMarkCompleted
 * (migration 0009), not from an assumption. mark_appointment_completed enforces
 * the same setting itself.
 */
export default async function StaffAppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { id } = await params;
  const [detail, config] = await Promise.all([
    getAppointmentDetail(session, id),
    getBookingConfig(),
  ]);

  if (!detail) return <NotAvailable />;

  return (
    <AppointmentDetailView
      detail={detail}
      capabilities={capabilitiesFor(session, detail, config.staffCanMarkCompleted)}
      config={config}
      // Only when this person genuinely belongs to more than one workspace.
      showWorkspace={session.workspaces.length > 1}
      backHref="/my/calendar"
      invoiceHref={`/my/appointments/${id}/invoice`}
    />
  );
}

async function NotAvailable() {
  const { t } = await getI18n();
  return (
    <div className="py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">{t("Appointment not available")}</h1>
      <p className="mt-2 text-sm text-slate-600">
        {t("This appointment does not exist, or is no longer available.")}
      </p>
      <Link
        href="/my/calendar"
        className="mt-6 inline-block rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 transition hover:bg-slate-50"
      >
        {t("Back to calendar")}
      </Link>
    </div>
  );
}
