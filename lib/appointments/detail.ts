import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";

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
  staffName: string | null;
  workspaceId: string;
  workspaceName: string | null;
  items: DetailItem[];
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
    workspaceId: row.workspace_id,
    workspaceName: one(row.workspace)?.name ?? null,
    items: (row.appointment_items ?? []).map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      lineTotal: i.line_total === null ? i.quantity * Number(i.unit_price) : Number(i.line_total),
    })),
    isOwnAppointment: session.staffId !== null && session.staffId === row.staff_id,
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
};

export function capabilitiesFor(
  session: SessionContext,
  detail: AppointmentDetail,
  staffCanMarkCompleted: boolean,
): AppointmentCapabilities {
  // Terminal appointments are history. The RPCs enforce this too
  // ("Only a booked appointment can be ..."), but offering the controls and
  // then refusing them would be pointless.
  const mutable = detail.status === "booked";
  const isMaster = session.isMaster;

  return {
    canEditCustomer: mutable,
    canEditItems: mutable,
    canReschedule: mutable,
    canCancel: mutable,
    // Staff completion is gated by a company setting that only the server can
    // see; 0009 surfaces it so this decision is real rather than assumed.
    canComplete: mutable && (isMaster || staffCanMarkCompleted),
    canOverride: isMaster,
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
