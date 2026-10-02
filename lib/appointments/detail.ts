import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import { staffColourIndexes } from "@/lib/agenda/staff-colour";
import type { SessionContext } from "@/lib/auth/session";
import { addDays, businessToday } from "@/lib/agenda/queries";

/**
 * Single-appointment lookup for the detail page.
 *
 * The privacy property: a hidden appointment and a nonexistent one produce the
 * SAME result — `null`. There is no "exists but not yours" branch, no distinct
 * status code and no different message, because any of those would confirm that
 * an appointment exists. Row Level Security does the filtering, so a guessed
 * uuid simply returns no row.
 *
 * The caller renders one generic unavailable state for `null`.
 */

export type DetailItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

/**
 * Extra work sold on site (migration 0013). Not part of totalAmount: items are
 * what was booked and drive scheduling; add-ons are what was added afterwards.
 */
export type DetailAddon = {
  id: string;
  description: string;
  amount: number;
  createdAt: string;
  /** Whether this caller may remove it — advisory; the RPC re-checks. */
  canRemove: boolean;
};

export type AppointmentDetail = {
  id: string;
  status: "booked" | "completed" | "cancelled";
  date: string;
  startTime: string;
  /** Working end, excluding the buffer. */
  endTime: string;
  durationMin: number;
  bufferMin: number;
  customerName: string;
  customerPhone: string | null;
  addressLine: string | null;
  areaCity: string | null;
  remarks: string | null;
  totalAmount: number;
  isLargeJob: boolean;
  staffId: string | null;
  /** Rank into the staff palette, matching every other surface. */
  staffColourIndex: number;
  staffName: string | null;
  workspaceId: string;
  workspaceName: string | null;
  items: DetailItem[];
  addons: DetailAddon[];
  /**
   * False when the add-on table could not be read — e.g. the app deployed ahead
   * of migration 0013. The section is then hidden rather than shown empty.
   */
  addonsAvailable: boolean;
  /** True when this caller is the assigned staff member. */
  isOwnAppointment: boolean;
};

// Operational fields only. Deliberately absent: audit rows, rule-override
// internals, conflicting appointment ids, created_by, occupied_range and any
// other scheduling or security metadata.
const SELECT = `
  id, status, appt_date, start_time, final_duration_min, buffer_minutes,
  customer_name, customer_phone, address_line, area_city, remarks,
  total_amount, is_large_job, staff_id, workspace_id,
  staff:staff_id(display_name),
  workspace:workspace_id(name),
  appointment_items(id, description, quantity, unit_price, line_total)
`;

type Row = {
  id: string;
  status: AppointmentDetail["status"];
  appt_date: string;
  start_time: string;
  final_duration_min: number;
  buffer_minutes: number;
  customer_name: string;
  customer_phone: string | null;
  address_line: string | null;
  area_city: string | null;
  remarks: string | null;
  total_amount: string | number;
  is_large_job: boolean;
  staff_id: string | null;
  workspace_id: string;
  staff: { display_name: string } | { display_name: string }[] | null;
  workspace: { name: string } | { name: string }[] | null;
  appointment_items: Array<{
    id: string; description: string; quantity: number;
    unit_price: string | number; line_total: string | number | null;
  }> | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function getAppointmentDetail(
  session: SessionContext,
  appointmentId: string,
): Promise<AppointmentDetail | null> {
  // Reject anything that is not a uuid before querying, so a malformed id
  // cannot produce a database error that differs from "not found".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appointmentId)) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select(SELECT)
    .eq("id", appointmentId)
    .maybeSingle();

  // An error here is also reported as "not available" rather than surfaced —
  // the alternative leaks the difference between refusal and absence.
  if (error || !data) return null;

  const row = data as unknown as Row;
  const startMinutes = toMinutes(row.start_time);

  // The same ranking the agenda uses, so one person is one colour whether they
  // are seen in a month cell or on their own appointment.
  // Add-ons are read separately rather than embedded, so a database without
  // migration 0013 degrades to "no add-on section" instead of breaking the
  // whole appointment page. Same RLS predicate as the appointment itself.
  const [{ data: staffRows }, addonRead] = await Promise.all([
    supabase.from("staff").select("id"),
    supabase
      .from("appointment_addons")
      .select("id, description, amount, created_by, created_at")
      .eq("appointment_id", row.id)
      .order("created_at"),
  ]);
  const colours = staffColourIndexes((staffRows ?? []).map((r) => r.id as string));
  const isOwn = session.staffId !== null && session.staffId === row.staff_id;
  const addonRows = (addonRead.data ?? []) as Array<{
    id: string; description: string; amount: string | number; created_by: string; created_at: string;
  }>;

  return {
    id: row.id,
    status: row.status,
    date: row.appt_date,
    startTime: row.start_time.slice(0, 5),
    endTime: fromMinutes(startMinutes + row.final_duration_min),
    durationMin: row.final_duration_min,
    bufferMin: row.buffer_minutes,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    addressLine: row.address_line,
    areaCity: row.area_city,
    remarks: row.remarks,
    totalAmount: Number(row.total_amount),
    isLargeJob: row.is_large_job,
    staffId: row.staff_id,
    staffName: one(row.staff)?.display_name ?? null,
    staffColourIndex: row.staff_id ? (colours.get(row.staff_id) ?? -1) : -1,
    workspaceId: row.workspace_id,
    workspaceName: one(row.workspace)?.name ?? null,
    items: (row.appointment_items ?? []).map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      lineTotal: i.line_total === null ? i.quantity * Number(i.unit_price) : Number(i.line_total),
    })),
    addons: addonRows.map((a) => ({
      id: a.id,
      description: a.description,
      amount: Number(a.amount),
      createdAt: a.created_at,
      // Mirrors remove_appointment_addon(): a Master of the workspace, or the
      // staff member who recorded it while still assigned.
      canRemove: session.isMaster || (isOwn && a.created_by === session.userId),
    })),
    addonsAvailable: !addonRead.error,
    isOwnAppointment: isOwn,
  };
}

/**
 * Which actions the UI may offer.
 *
 * Advisory only — every RPC re-checks for itself, and the server is the
 * authority. This exists so the page does not render controls the server will
 * refuse, which is confusing rather than secure.
 */
export type AppointmentCapabilities = {
  canEditCustomer: boolean;
  canEditItems: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  canComplete: boolean;
  /** Only a Master may supply a large-job override reason. */
  canOverride: boolean;
  /** Record extra work sold on site. Allowed after completion, too. */
  canAddAddon: boolean;
  /**
   * A staff member past the 3-day edit window (migration 0015): they can read
   * the appointment and still mark it completed, nothing else.
   */
  staffLocked: boolean;
};

/**
 * Mirrors public.staff_edit_window_open: editable through three days after the
 * appointment date (business-local), locked from the fourth.
 */
export function staffEditWindowOpen(apptDate: string): boolean {
  return apptDate >= addDays(businessToday(), -3);
}

export function capabilitiesFor(
  session: SessionContext,
  detail: AppointmentDetail,
  staffCanMarkCompleted: boolean,
): AppointmentCapabilities {
  const isMaster = session.isMaster;
  // The database refuses these too (trg_enforce_staff_edit_window); hiding the
  // controls just avoids offering something that will be refused.
  const staffLocked = !isMaster && !staffEditWindowOpen(detail.date);
  // Terminal appointments are history. The RPCs enforce this too
  // ("Only a booked appointment can be ..."), but offering the controls and
  // then refusing them would be pointless.
  const mutable = detail.status === "booked";
  const editable = mutable && !staffLocked;

  return {
    staffLocked,
    canEditCustomer: editable,
    canEditItems: editable,
    canReschedule: editable,
    canCancel: editable,
    // Staff completion is gated by a company setting that only the server can
    // see; 0009 surfaces it so this decision is real rather than assumed.
    canComplete: mutable && (isMaster || staffCanMarkCompleted),
    canOverride: isMaster,
    // Unlike the booking itself, an add-on is usually recorded at or after the
    // end of the job, so a completed appointment still takes one. Cancelled
    // work earned nothing, and an unassigned job has nobody to credit.
    canAddAddon:
      !staffLocked &&
      detail.addonsAvailable &&
      detail.status !== "cancelled" &&
      detail.staffId !== null &&
      (isMaster || detail.isOwnAppointment),
  };
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h as number) * 60 + (m as number);
}
function fromMinutes(total: number): string {
  const h = Math.floor(total / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
