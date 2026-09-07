import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { getAppointmentDetail, capabilitiesFor } from "@/lib/appointments/detail";
import { getBookingConfig } from "@/lib/booking-config/queries";
import { AppointmentDetailView } from "@/components/appointment-detail/AppointmentDetailView";

export const metadata = { title: "Appointment — Mr Clean & Clean Ops" };

/**
 * Master appointment detail.
 *
 * A hidden appointment and a nonexistent one render the SAME state: the lookup
 * is RLS-filtered and returns null for both, and there is no branch that could
 * tell them apart. Nick pasting Victor's appointment id sees exactly what he
 * sees for a random uuid.
 */
export default async function MasterAppointmentDetailPage({
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

  if (!detail) return <NotAvailable backHref="/calendar" />;

  return (
    <AppointmentDetailView
      detail={detail}
      capabilities={capabilitiesFor(session, detail, config.staffCanMarkCompleted)}
      config={config}
      // Only meaningful to a Master who administers more than one workspace.
      showWorkspace={session.workspaces.length > 1}
      backHref="/calendar"
    />
  );
}

function NotAvailable({ backHref }: { backHref: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Appointment not available</h1>
      <p className="mt-2 text-sm text-slate-600">
        This appointment does not exist, or is no longer available.
      </p>
      <Link
        href={backHref}
        className="mt-6 inline-block rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 transition hover:bg-slate-50"
      >
        Back to calendar
      </Link>
    </div>
  );
}
