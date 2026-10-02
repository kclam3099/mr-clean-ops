import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import { getCalendarStaff } from "@/lib/agenda/staff";

/**
 * Who has seen today's work, for the Master home page.
 *
 * Three states, and the rule for each is about what the VIEWER can see, not
 * about what is true:
 *
 *   none   no appointments visible to this Master today
 *   seen   has appointments today, and has acknowledged them
 *   unseen has appointments today, and has not
 *
 * That distinction is the whole privacy design, and it is easy to get wrong
 * here. If Dyron's only job today is in KC Private Team, Nick must see "none"
 * — not "unseen" — because "there is something you have not seen" tells Nick a
 * job exists that he is not allowed to know about. The counts therefore come
 * from the same RLS-filtered appointment read as the rest of the page, and a
 * Master and a Super Master can honestly see different colours for the same
 * person on the same morning.
 *
 * The staff list comes from getCalendarStaff for the same reason the calendar
 * does: one RLS-visible roster, not a second query that could drift and put a
 * Victor row on Nick's screen.
 */

export type StaffDayState = "seen" | "unseen" | "none";

export type StaffDayStatus = {
  staffId: string;
  name: string;
  state: StaffDayState;
  /** Appointments visible to THIS viewer today. */
  appointments: number;
  /** Business-local HH:MM the acknowledgement was made, or null. */
  acknowledgedAt: string | null;
  /** True when acknowledged after the morning deadline. */
  late: boolean;
};

export const ACKNOWLEDGE_BY_HOUR = 8;

const BUSINESS_TZ = "Asia/Kuala_Lumpur";

/** HH:MM in business-local time. */
function businessTimeOf(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${hour}:${get("minute")}`;
}

export async function getStaffDayStatus(
  session: SessionContext,
  scope: WorkspaceScope,
  date: string,
): Promise<{ ok: true; rows: StaffDayStatus[] } | { ok: false }> {
  const roster = await getCalendarStaff(session, scope);
  if (roster.length === 0) return { ok: true, rows: [] };

  const ids = roster.map((s) => s.id);
  const supabase = await createClient();

  const [appointments, acks] = await Promise.all([
    supabase
      .from("appointments")
      .select("staff_id")
      .eq("appt_date", date)
      .eq("status", "booked")
      .in("staff_id", ids),
    supabase
      .from("staff_day_acknowledgements")
      .select("staff_id, acknowledged_at")
      .eq("ack_date", date)
      .in("staff_id", ids),
  ]);

  if (appointments.error || acks.error) return { ok: false };

  const counts = new Map<string, number>();
  for (const row of appointments.data ?? []) {
    const id = row.staff_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const ackAt = new Map<string, string>();
  for (const row of acks.data ?? []) {
    ackAt.set(row.staff_id as string, row.acknowledged_at as string);
  }

  const rows = roster.map((s): StaffDayStatus => {
    const appointmentCount = counts.get(s.id) ?? 0;
    const at = ackAt.get(s.id) ?? null;
    const localTime = at ? businessTimeOf(at) : null;

    // Lateness is only meaningful against work there was to see.
    const late =
      appointmentCount > 0 &&
      localTime !== null &&
      Number(localTime.slice(0, 2)) >= ACKNOWLEDGE_BY_HOUR;

    return {
      staffId: s.id,
      name: s.name,
      state: appointmentCount === 0 ? "none" : at ? "seen" : "unseen",
      appointments: appointmentCount,
      acknowledgedAt: localTime,
      late,
    };
  });

  // Needs attention first: the point of this panel is the person who has not
  // looked, and sorting it alphabetically buries them among the people who have.
  const order: Record<StaffDayState, number> = { unseen: 0, seen: 1, none: 2 };
  rows.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));

  return { ok: true, rows };
}
