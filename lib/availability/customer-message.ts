/**
 * The customer-facing availability message.
 *
 * The owner's real question is not "which of my staff is free" — it is "what do
 * I paste back to the customer who just asked when we can come". So this turns
 * raw slots into one ready-to-send WhatsApp message.
 *
 * Two rules shape it, and both exist to protect the customer's view of the
 * business rather than to expose the schedule:
 *
 *   UNION — a time appears if ANY of the operational staff can take it. The
 *   customer does not care who comes, so the staff dimension is collapsed away
 *   and duplicates are removed.
 *
 *   OMISSION — a day with no available time is left out entirely, rather than
 *   printed with an empty list. An empty heading invites "why not Thursday?",
 *   which is a question about the schedule.
 *
 * The message therefore carries only a heading, weekdays and times. No staff
 * name, no workspace, no count, and never a reason a slot is missing — a hidden
 * appointment removes a time silently, which is the whole point.
 *
 * Pure: no clock, no database. The caller supplies the slots and the range.
 */

export type RangePreset = "today" | "tomorrow" | "thisWeek" | "nextWeek" | "custom";

export type MessageSlot = { date: string; time: string };

const HEADINGS: Record<RangePreset, string> = {
  today: "今天可预约时间 😊",
  tomorrow: "明天可预约时间 😊",
  thisWeek: "这个星期可预约时间 😊",
  nextWeek: "下个星期可预约时间 😊",
  custom: "可预约时间 😊",
};

const EMPTY: Record<RangePreset, string> = {
  today: "今天暂时没有可预约时间",
  tomorrow: "明天暂时没有可预约时间",
  thisWeek: "这个星期暂时没有可预约时间",
  nextWeek: "下个星期暂时没有可预约时间",
  custom: "暂时没有可预约时间",
};

/** 0 = Sunday, matching Date#getUTCDay. */
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** `13:00` -> `1pm`, `10:00` -> `10am`, `09:30` -> `9.30am`. */
export function friendlyTime(hhmm: string): string {
  const [hRaw, mRaw] = hhmm.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${suffix}` : `${hour12}.${String(m).padStart(2, "0")}${suffix}`;
}

export function weekdayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return WEEKDAYS[d.getUTCDay()] as string;
}

export type MessageDay = { date: string; weekday: string; times: string[] };

/**
 * Collapses per-staff slots into per-day times.
 *
 * Union across staff, deduplicated, chronological, and days with nothing
 * available are dropped rather than emitted empty.
 */
export function groupSlotsForCustomer(slots: MessageSlot[]): MessageDay[] {
  const byDate = new Map<string, Set<string>>();
  for (const s of slots) {
    if (!s.date || !s.time) continue;
    const bucket = byDate.get(s.date) ?? new Set<string>();
    bucket.add(s.time);
    byDate.set(s.date, bucket);
  }

  return [...byDate.entries()]
    .filter(([, times]) => times.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, times]) => ({
      date,
      weekday: weekdayLabel(date),
      times: [...times].sort((a, b) => a.localeCompare(b)).map(friendlyTime),
    }));
}

/** The exact text the owner copies and pastes into WhatsApp. */
export function buildCustomerMessage(slots: MessageSlot[], preset: RangePreset): string {
  const days = groupSlotsForCustomer(slots);
  if (days.length === 0) return EMPTY[preset];

  return [
    HEADINGS[preset],
    "",
    ...days.flatMap((d, i) => (i === 0 ? [d.weekday, d.times.join(", ")] : ["", d.weekday, d.times.join(", ")])),
  ].join("\n");
}

export function messageHeading(preset: RangePreset): string {
  return HEADINGS[preset];
}
