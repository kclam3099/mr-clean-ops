import type { LeaveRequest } from "@/lib/leave/queries";

/** "Sat 3 Oct", "Sat 3 Oct – Mon 5 Oct", or "Sat 3 Oct, 10:00–12:00". */
export function leaveWhen(r: Pick<LeaveRequest, "startDate" | "endDate" | "startTime" | "endTime">, locale: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
  };
  if (r.startTime && r.endTime) return `${fmt(r.startDate)}, ${r.startTime}–${r.endTime}`;
  if (r.startDate === r.endDate) return fmt(r.startDate);
  return `${fmt(r.startDate)} – ${fmt(r.endDate)}`;
}

/** Whole days covered, for "3 days". Part of a day counts as one. */
export function leaveDays(r: Pick<LeaveRequest, "startDate" | "endDate">): number {
  const ms = Date.parse(`${r.endDate}T00:00:00Z`) - Date.parse(`${r.startDate}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}
