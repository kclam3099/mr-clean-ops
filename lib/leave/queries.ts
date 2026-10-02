import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";
import { addDays, businessToday } from "@/lib/agenda/queries";

/**
 * Leave requests (migration 0014), read through RLS.
 *
 * A staff member's read returns their own rows; a Master's returns rows for
 * staff in the workspaces they administer — the same predicate as time off.
 * Neither read ever filters by hand on who may see what: RLS has already done
 * it, so Nick's pending list simply has no Victor in it.
 *
 * Both readers return an empty list rather than an error when the table is not
 * there, so the app can ship ahead of the migration without breaking a page.
 */

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export type LeaveRequest = {
  id: string;
  staffId: string;
  staffName: string | null;
  startDate: string;
  endDate: string;
  /** "HH:MM", or null for full day(s). */
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
  status: LeaveStatus;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

const SELECT =
  "id, staff_id, start_date, end_date, start_time, end_time, reason, status, " +
  "requested_at, decided_at, decision_note, staff:staff_id(display_name)";

type Row = {
  id: string;
  staff_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  status: LeaveStatus;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
  staff: { display_name: string } | { display_name: string }[] | null;
};

function toLeave(r: Row): LeaveRequest {
  const staff = Array.isArray(r.staff) ? r.staff[0] : r.staff;
  return {
    id: r.id,
    staffId: r.staff_id,
    staffName: staff?.display_name ?? null,
    startDate: r.start_date,
    endDate: r.end_date,
    startTime: r.start_time ? r.start_time.slice(0, 5) : null,
    endTime: r.end_time ? r.end_time.slice(0, 5) : null,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
  };
}

/** The caller's own requests: anything not yet over, plus the last 60 days. */
export async function getMyLeaveRequests(session: SessionContext): Promise<{
  available: boolean;
  requests: LeaveRequest[];
}> {
  if (!session.staffId) return { available: true, requests: [] };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_leave_requests")
    .select(SELECT)
    .eq("staff_id", session.staffId)
    .gte("end_date", addDays(businessToday(), -60))
    .order("start_date", { ascending: false })
    .limit(50);
  if (error) return { available: false, requests: [] };
  return { available: true, requests: (data as unknown as Row[]).map(toLeave) };
}

/** Pending requests this Master may decide, oldest first. */
export async function getPendingLeaveForMaster(session: SessionContext): Promise<LeaveRequest[]> {
  if (!session.isMaster) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_leave_requests")
    .select(SELECT)
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .limit(50);
  if (error) return [];
  return (data as unknown as Row[]).map(toLeave);
}
