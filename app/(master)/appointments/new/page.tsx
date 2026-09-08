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
 * Master Add Appointment.
 *
 * Every search param is a HINT. `resolveBookingContext` enumerates what this
 * caller can see first and matches the hints against that, so `?staff=<uuid>`
 * for someone invisible resolves to nothing — no fetch, no render, no error
 * that would confirm the id exists.
 *
 * "All Operations" is not a workspace. Arriving from it simply means no
 * workspace hint, so the form requires a real one before anything can be saved.
 */
export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; staff?: string; date?: string; time?: string; return?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const [context, config] = await Promise.all([
    resolveBookingContext(session, { ws: params.ws, staff: params.staff }),
    getBookingConfig(),
  ]);

  const today = businessToday();
  // A past date is no longer rejected as a hint: historical appointments are
  // recordable, and the confirmation happens at save time.
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : undefined;
  const time = params.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(params.time) ? params.time : undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">New appointment</h1>
          <p className="text-sm text-slate-500">
            {context.workspaces.length === 0
              ? "No workspace available for booking."
              : "Choose the workspace and team member, then the job details."}
          </p>
        </div>
        <Link
          href="/calendar"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
        >
          Cancel
        </Link>
      </div>

      {context.workspaces.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          There is no workspace with active team members available to you.
        </p>
      ) : (
        <AppointmentForm
          context={context}
          config={config}
          returnTo={params.return}
          initialDate={date}
          initialTime={time}
          businessToday={today}
          businessNow={businessNowLocal()}
        />
      )}
    </div>
  );
}
