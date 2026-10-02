import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import { getMasterAgenda, monthRange } from "@/lib/agenda/queries";
import { staffColourIndexes } from "@/lib/agenda/staff-colour";
import { logAndMap, type AppError } from "@/lib/errors/appError";

/**
 * The monthly report: booked work and add-ons, per staff member.
 *
 * Built from rows, never from an aggregate RPC. Both reads go through RLS, so a
 * Shared-Team-only Master's report is a Shared-Team report by construction —
 * including for a staff member shared with a workspace they cannot see, whose
 * add-ons on the hidden side simply are not in the rows.
 *
 * Booked revenue and add-on revenue stay in separate columns. An add-on is not
 * part of total_amount (see migration 0013), so adding the two would be a new
 * figure, not a correction of either.
 *
 * The month is the APPOINTMENT's month, not the day the add-on was typed in: a
 * job on 30 September whose add-on was recorded on 1 October is September work.
 */

export type ReportAddon = {
  id: string;
  appointmentId: string;
  date: string;
  customerName: string;
  description: string;
  amount: number;
};

export type StaffMonthRow = {
  staffId: string;
  staffName: string;
  colourIndex: number;
  jobs: number;
  booked: number;
  addonCount: number;
  addonAmount: number;
  addons: ReportAddon[];
};

export type MonthlyReport =
  | {
      ok: true;
      rows: StaffMonthRow[];
      totals: { jobs: number; booked: number; addonCount: number; addonAmount: number };
      /** False when the add-on table is not there yet (app ahead of 0013). */
      addonsAvailable: boolean;
    }
  | { ok: false; error: AppError };

type AddonRow = {
  id: string;
  description: string;
  amount: string | number;
  staff_id: string;
  staff: { display_name: string } | { display_name: string }[] | null;
  appointment:
    | { id: string; appt_date: string; customer_name: string }
    | { id: string; appt_date: string; customer_name: string }[]
    | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function getMonthlyReport(
  session: SessionContext,
  scope: WorkspaceScope,
  anchor: string,
): Promise<MonthlyReport> {
  const range = monthRange(anchor);
  const supabase = await createClient();

  let addonQuery = supabase
    .from("appointment_addons")
    .select(
      "id, description, amount, staff_id, staff:staff_id(display_name), " +
      "appointment:appointment_id!inner(id, appt_date, customer_name, status, workspace_id)",
    )
    .gte("appointment.appt_date", range.from)
    .lte("appointment.appt_date", range.to)
    // Cancelled work earned nothing, even if an add-on was recorded before the
    // cancellation.
    .neq("appointment.status", "cancelled");
  if (scope.kind === "workspace") {
    addonQuery = addonQuery.eq("appointment.workspace_id", scope.workspaceId);
  }

  const [agenda, addonRead, staffRead] = await Promise.all([
    getMasterAgenda(session, scope, range),
    addonQuery,
    supabase.from("staff").select("id"),
  ]);
  if (!agenda.ok) return { ok: false, error: agenda.error };

  const colours = staffColourIndexes((staffRead.data ?? []).map((r) => r.id as string));
  const byStaff = new Map<string, StaffMonthRow>();
  const rowFor = (staffId: string, staffName: string | null): StaffMonthRow => {
    let row = byStaff.get(staffId);
    if (!row) {
      row = {
        staffId,
        staffName: staffName ?? "Staff",
        colourIndex: colours.get(staffId) ?? -1,
        jobs: 0, booked: 0, addonCount: 0, addonAmount: 0, addons: [],
      };
      byStaff.set(staffId, row);
    }
    return row;
  };

  for (const a of agenda.appointments) {
    if (!a.staffId) continue;
    const row = rowFor(a.staffId, a.staffName);
    row.jobs += 1;
    row.booked += a.totalAmount ?? 0;
  }

  // A failed add-on read must not take the booked half down with it: that half
  // is still right. The page says add-ons are unavailable instead (e.g. the app
  // deployed ahead of migration 0013), and the cause is logged.
  const addonsAvailable = !addonRead.error;
  if (addonRead.error) logAndMap("getMonthlyReport.addons", addonRead.error);

  for (const r of (addonRead.data ?? []) as unknown as AddonRow[]) {
    const appt = one(r.appointment);
    if (!appt) continue;
    const row = rowFor(r.staff_id, one(r.staff)?.display_name ?? null);
    const amount = Number(r.amount);
    row.addonCount += 1;
    row.addonAmount += amount;
    row.addons.push({
      id: r.id,
      appointmentId: appt.id,
      date: appt.appt_date,
      customerName: appt.customer_name,
      description: r.description,
      amount,
    });
  }

  const rows = [...byStaff.values()].sort(
    (x, y) => y.addonAmount - x.addonAmount || y.booked - x.booked || x.staffName.localeCompare(y.staffName),
  );
  for (const row of rows) row.addons.sort((x, y) => x.date.localeCompare(y.date));

  return {
    ok: true,
    rows,
    totals: rows.reduce(
      (t, r) => ({
        jobs: t.jobs + r.jobs,
        booked: t.booked + r.booked,
        addonCount: t.addonCount + r.addonCount,
        addonAmount: t.addonAmount + r.addonAmount,
      }),
      { jobs: 0, booked: 0, addonCount: 0, addonAmount: 0 },
    ),
    addonsAvailable,
  };
}
