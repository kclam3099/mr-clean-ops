import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveBookingContext } from "@/lib/appointments/context";
import { getBookingConfig } from "@/lib/booking-config/queries";
import { businessToday } from "@/lib/agenda/queries";
import { businessNowLocal } from "@/lib/appointments/message-parser";
import { AppointmentForm } from "@/components/appointment-form/AppointmentForm";

export const metadata = { title: "New appointment — Mr Clean & Clean Ops" };

/**
 * Staff Add Appointment. Mobile-first, single column.
 *
 * No staff selector exists, and no staff id is submitted — `create_appointment`
 * derives the caller's staff row from the JWT. A workspace selector renders
 * only when this person genuinely belongs to more than one; with a single
 * membership it is derived silently.
 *
 * The staff dashboard itself stays merged and identity-scoped; workspace is a
 * question only here, where the booking needs attribution.
 */
export default async function NewStaffAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; time?: string; return?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const [context, config] = await Promise.all([
    resolveBookingContext(session),
    getBookingConfig(),
  ]);

  const today = businessToday();
  // A past date is no longer rejected as a hint: historical appointments are
  // recordable, and the confirmation happens at save time.
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : undefined;
  const time = params.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(params.time) ? params.time : undefined;

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">New appointment</h1>
        <Link
          href="/my/today"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
        >
          Cancel
        </Link>
      </div>

      {context.workspaces.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          You are not an active member of any workspace, so you cannot create appointments.
          Please contact your manager.
        </p>
      ) : (
        <AppointmentForm
          context={context}
          config={config}
          returnTo={params.return ?? "today"}
          initialDate={date}
          initialTime={time}
          businessToday={today}
          businessNow={businessNowLocal()}
        />
      )}
    </div>
  );
}
