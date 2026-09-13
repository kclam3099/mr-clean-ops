import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import { logAndMap, type AppError } from "@/lib/errors/appError";

/**
 * The shared read layer behind every calendar and agenda surface.
 *
 * Reads go through the caller's own Supabase session, so Row Level Security is
 * the boundary — not the filters below. The filters exist to express intent and
 * to keep queries small; they are never the thing preventing a leak. A row this
 * caller may not see is not returned even if a filter is wrong.
 *
 * Two shapes, deliberately different:
 *
 *   Master — workspace-scoped. "All Operations" applies no workspace filter at
 *   all, which merges exactly the workspaces RLS already allows. It never
 *   queries an "All Operations" workspace, because no such row exists.
 *
 *   Staff — IDENTITY-scoped, and always merged. A staff member sees their own
 *   appointments across every workspace they belong to, in one agenda. There is
 *   no workspace switcher on the staff side; workspace only ever matters when
 *   an operation needs attribution.
 */

export type AppointmentStatus = "booked" | "completed" | "cancelled";

export type AgendaAppointment = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMin: number;
  bufferMin: number;
  customerName: string;
  customerPhone: string | null;
  addressLine: string | null;
  areaCity: string | null;
  totalAmount: number | null;
  isLargeJob: boolean;
  status: AppointmentStatus;
  remarks: string | null;
  staffId: string | null;
  staffName: string | null;
  workspaceId: string;
  workspaceName: string | null;
};

export type AgendaResult =
  | { ok: true; appointments: AgendaAppointment[] }
  | { ok: false; error: AppError };

export type DateRange = { from: string; to: string };

// Only columns the current surfaces actually render. Selecting explicitly keeps
// new columns from silently appearing in a payload that reaches the browser.
const SELECT =
  "id, appt_date, start_time, final_duration_min, buffer_minutes, customer_name, " +
  "customer_phone, address_line, area_city, total_amount, is_large_job, status, remarks, " +
  "staff_id, workspace_id, staff:staff_id(display_name), workspace:workspace_id(name)";

type Row = {
  id: string;
  appt_date: string;
  start_time: string;
  final_duration_min: number;
  buffer_minutes: number;
  customer_name: string;
  customer_phone: string | null;
  address_line: string | null;
  area_city: string | null;
  total_amount: string | number | null;
  is_large_job: boolean;
  status: AppointmentStatus;
  remarks: string | null;
  staff_id: string | null;
  workspace_id: string;
  staff: { display_name: string } | { display_name: string }[] | null;
  workspace: { name: string } | { name: string }[] | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

function toAppointment(row: Row): AgendaAppointment {
  const startMinutes = toMinutes(row.start_time);
  return {
    id: row.id,
    date: row.appt_date,
    startTime: hhmm(row.start_time),
    // Working end, excluding the buffer — the buffer blocks the calendar but is
    // not part of the job the customer sees.
    endTime: fromMinutes(startMinutes + row.final_duration_min),
    durationMin: row.final_duration_min,
    bufferMin: row.buffer_minutes,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    addressLine: row.address_line,
    areaCity: row.area_city,
    totalAmount: row.total_amount === null ? null : Number(row.total_amount),
    isLargeJob: row.is_large_job,
    status: row.status,
    remarks: row.remarks,
    staffId: row.staff_id,
    staffName: one(row.staff)?.display_name ?? null,
    workspaceId: row.workspace_id,
    workspaceName: one(row.workspace)?.name ?? null,
  };
}

/** Master calendar/agenda for a workspace scope. */
export async function getMasterAgenda(
  session: SessionContext,
  scope: WorkspaceScope,
  range: DateRange,
): Promise<AgendaResult> {
  if (!session.isMaster) {
    return { ok: false, error: logAndMap("getMasterAgenda", "Not authorized") };
  }
  const supabase = await createClient();

  let query = supabase
    .from("appointments")
    .select(SELECT)
    .gte("appt_date", range.from)
    .lte("appt_date", range.to)
    .neq("status", "cancelled")
    .order("appt_date")
    .order("start_time");

  // "All Operations" applies no workspace filter — RLS already limits the rows
  // to this Master's workspaces, and merging them IS the virtual view.
  if (scope.kind === "workspace") {
    query = query.eq("workspace_id", scope.workspaceId);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: logAndMap("getMasterAgenda", error) };
  return { ok: true, appointments: (data as unknown as Row[]).map(toAppointment) };
}

/**
 * Staff agenda — the caller's own appointments, merged across every workspace
 * they belong to. Never takes a workspace parameter.
 */
export async function getStaffAgenda(
  session: SessionContext,
  range: DateRange,
): Promise<AgendaResult> {
  if (!session.staffId) {
    return { ok: false, error: logAndMap("getStaffAgenda", "No staff profile for this account") };
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("appointments")
    .select(SELECT)
    .eq("staff_id", session.staffId)
    .gte("appt_date", range.from)
    .lte("appt_date", range.to)
    .neq("status", "cancelled")
    .order("appt_date")
    .order("start_time");

  if (error) return { ok: false, error: logAndMap("getStaffAgenda", error) };
  return { ok: true, appointments: (data as unknown as Row[]).map(toAppointment) };
}

// ---------------------------------------------------------------------------
// date + time helpers (Asia/Kuala_Lumpur — the business runs in one timezone,
// and the database stores local wall-clock dates and times, not timestamptz)
// ---------------------------------------------------------------------------

export const BUSINESS_TZ = "Asia/Kuala_Lumpur";

/** Today in the business timezone, as YYYY-MM-DD. */
export function businessToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Monday-anchored week containing `isoDate`. */
export function weekRange(isoDate: string): DateRange {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  const shift = (dt.getUTCDay() + 6) % 7;
  const from = addDays(isoDate, -shift);
  return { from, to: addDays(from, 6) };
}

export function monthRange(isoDate: string): DateRange {
  const [y, m] = isoDate.split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(y as number, m as number, 0)).getUTCDate();
  return { from: first, to: `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` };
}

export function singleDay(isoDate: string): DateRange {
  return { from: isoDate, to: isoDate };
}

/** `isoDate` moved by whole months, clamped to the end of a shorter month. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(y as number, (m as number) - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d as number, lastDay);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The dates a month CALENDAR shows: six Sunday-anchored weeks containing the
 * whole of `isoDate`'s month, leading and trailing days included.
 *
 * Six rows always, even when five would hold the month, so the grid does not
 * change height as you page through months — a dashboard that reflows on every
 * click is harder to read than one with a little empty space at the bottom.
 *
 * This is what the month query asks for, so exactly the visible cells are
 * fetched and nothing beyond them. Deliberately NOT `weekRange`, which is
 * Monday-anchored for the scheduling calendar.
 */
export function monthGridRange(isoDate: string): DateRange {
  const [y, m] = isoDate.split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const dow = new Date(Date.UTC(y as number, (m as number) - 1, 1)).getUTCDay(); // 0 = Sunday
  const from = addDays(first, -dow);
  return { from, to: addDays(from, 41) };
}

/** Every date in a month grid, in order. */
export function monthGridDays(isoDate: string): string[] {
  const { from } = monthGridRange(isoDate);
  return Array.from({ length: 42 }, (_, i) => addDays(from, i));
}

/** "2026-09-11" -> "2026-09", the month-navigation parameter. */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** "2026-09-11" -> "September 2026". */
export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y as number, (m as number) - 1, 1)));
}

/** True when both dates fall in the same calendar month. */
export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h as number) * 60 + (m as number);
}
function fromMinutes(total: number): string {
  const h = Math.floor(total / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function hhmm(time: string): string {
  return time.slice(0, 5);
}

/** Group into date buckets, preserving order, for agenda rendering. */
export function groupByDate(items: AgendaAppointment[]): Array<{ date: string; items: AgendaAppointment[] }> {
  const map = new Map<string, AgendaAppointment[]>();
  for (const a of items) {
    const bucket = map.get(a.date);
    if (bucket) bucket.push(a);
    else map.set(a.date, [a]);
  }
  return [...map.entries()].map(([date, list]) => ({ date, items: list }));
}
