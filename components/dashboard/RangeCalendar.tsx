import Link from "next/link";
import {
  monthGridRange, monthGridDays, monthKey, monthLabel, addMonths, sameMonth,
  weekDays, dashWeekRange, weekLabel, weekStart, addDays, type DateRange,
} from "@/lib/agenda/queries";
import { MonthOverview, type MonthEntry, type MonthStaff } from "@/components/dashboard/MonthOverview";
import { compactMoney } from "@/lib/pricing/duration";
import { getI18n } from "@/lib/i18n/server";

/**
 * The week / next-week / month calendar shared by the Master dashboard and the
 * staff calendar.
 *
 * It draws only what it is handed. WHICH appointments those are is decided by
 * the page, through RLS: a Master's dashboard reads its workspaces, a staff
 * member's calendar reads `staff_id = my_staff_id()` — their own work and
 * nobody else's. Nothing here queries, so nothing here can widen that.
 */

export type CalendarRange = "week" | "next-week" | "month";

export type ResolvedCalendar = {
  range: CalendarRange;
  isWeek: boolean;
  /** First of the month being shown (month view), or today. */
  anchor: string;
  /** Any date inside the week being shown (week views). */
  weekAnchor: string;
  month: string;
  /** What to fetch: exactly the cells the grid draws. */
  queryRange: DateRange;
  days: string[];
};

/**
 * Reads the hand-editable URL parameters. Lands on THIS WEEK; a bare ?month=
 * (older bookmarks, the month arrows) means the month; anything unrecognised
 * falls back rather than erroring.
 */
export function resolveCalendar(
  params: { range?: string; month?: string; week?: string },
  today: string,
): ResolvedCalendar {
  const range: CalendarRange =
    params.range === "week" || params.range === "next-week" || params.range === "month"
      ? params.range
      : params.month ? "month" : "week";

  const anchor = /^\d{4}-\d{2}$/.test(params.month ?? "") ? `${params.month}-01` : today;
  // The week views anchor on an explicit date when one is given, so paging
  // forward from "next week" keeps working past the end of the month.
  const weekAnchor = /^\d{4}-\d{2}-\d{2}$/.test(params.week ?? "")
    ? (params.week as string)
    : range === "next-week" ? addDays(weekStart(today), 7) : today;

  const isWeek = range !== "month";
  return {
    range,
    isWeek,
    anchor,
    weekAnchor,
    month: monthKey(anchor),
    queryRange: isWeek ? dashWeekRange(weekAnchor) : monthGridRange(anchor),
    days: isWeek ? weekDays(weekAnchor) : monthGridDays(anchor),
  };
}

export async function RangeCalendar({
  cal,
  today,
  basePath,
  baseQuery = {},
  entries,
  staff,
  detailHrefBase,
  beforeGrid,
  showSummary = true,
  showAmounts = true,
}: {
  cal: ResolvedCalendar;
  today: string;
  /** The page's own path, e.g. "/dashboard" or "/my/calendar". */
  basePath: string;
  /** Parameters every link keeps, e.g. the Master's workspace scope. */
  baseQuery?: Record<string, string>;
  entries: MonthEntry[];
  staff: MonthStaff[];
  detailHrefBase: string;
  /** Whatever needs acting on today, shown between the controls and the grid. */
  beforeGrid?: React.ReactNode;
  /** The range's count and total. A Master's figure; off on the staff calendar. */
  showSummary?: boolean;
  /** Day totals and job prices in the grid; off on the staff calendar. */
  showAmounts?: boolean;
}) {
  const { t, locale } = await getI18n();
  const { range, isWeek, anchor, weekAnchor, month, days } = cal;

  const href = (extra: Record<string, string>) => {
    const q = new URLSearchParams(baseQuery);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `${basePath}?${q.toString()}`;
  };
  // The month is not the default, so it is always named explicitly.
  const rangeHref = (r: CalendarRange, weekIso?: string) =>
    href(r !== "month" && weekIso ? { range: r, week: weekIso } : { range: r });
  const monthHref = (m: string) => href({ range: "month", month: m });

  // Totals describe the MONTH, not the 42-day grid, so the leading and trailing
  // days from the neighbouring months do not inflate them. For a week every
  // visible day belongs to it. Computed from the rows this caller received —
  // never a separate aggregate.
  const inRange = isWeek ? entries : entries.filter((e) => sameMonth(e.date, anchor));
  const revenue = inRange.reduce((sum, e) => sum + (e.totalAmount ?? 0), 0);
  const largeJobs = inRange.filter((e) => e.isLargeJob).length;

  return (
    <>
      {/* Range first, navigation second. Which span you are looking at is the
          bigger decision, and putting it on the same row as the arrows made
          "next" ambiguous — next week or next month? */}
      <div
        role="tablist"
        aria-label={t("Date range")}
        data-range-tabs
        className="inline-flex rounded-xl border border-line bg-card p-0.5"
      >
        {([
          ["week", t("This week"), rangeHref("week")],
          ["next-week", t("Next week"), rangeHref("next-week")],
          ["month", t("This month"), rangeHref("month")],
        ] as const).map(([key, label, to]) => {
          const active = key === "month" ? !isWeek : range === key;
          return (
            <Link
              key={key}
              href={to}
              role="tab"
              aria-selected={active}
              data-range={key}
              data-active={active ? "true" : undefined}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-semibold
                          transition-colors duration-200 ${
                            active
                              ? "bg-brand text-white"
                              : "text-ink-muted hover:bg-sunken hover:text-ink"
                          }`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <Link
            href={isWeek ? rangeHref(range, weekStart(today)) : monthHref(monthKey(today))}
            data-month-today
            className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium
                       text-ink transition hover:bg-sunken"
          >
            {t("Today")}
          </Link>
          <Link
            href={isWeek
              ? rangeHref(range, addDays(weekStart(weekAnchor), -7))
              : monthHref(monthKey(addMonths(anchor, -1)))}
            data-month-prev
            aria-label={isWeek ? t("Previous week") : t("Previous month")}
            className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm
                       text-ink transition hover:bg-sunken"
          >
            <span aria-hidden="true">←</span>
          </Link>
          <Link
            href={isWeek
              ? rangeHref(range, addDays(weekStart(weekAnchor), 7))
              : monthHref(monthKey(addMonths(anchor, 1)))}
            data-month-next
            aria-label={isWeek ? t("Next week") : t("Next month")}
            className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm
                       text-ink transition hover:bg-sunken"
          >
            <span aria-hidden="true">→</span>
          </Link>
          <h2 className="ml-1.5 text-base font-semibold tracking-tight text-ink" data-month-label>
            {isWeek ? weekLabel(weekAnchor, locale) : monthLabel(anchor, locale)}
          </h2>
        </div>

        {showSummary ? (
        <p className="text-xs text-ink-muted" data-month-summary>
          <span className="tabular-nums">{inRange.length}</span>
          {inRange.length === 1 ? t(" appointment") : t(" appointments")}
          {" · "}
          <span className="tabular-nums">{compactMoney(revenue)}</span>
          {largeJobs > 0 ? (
            <>
              {" · "}
              <span className="tabular-nums">{largeJobs}</span>
              {largeJobs === 1 ? t(" large job") : t(" large jobs")}
            </>
          ) : null}
        </p>
        ) : null}
      </div>

      {beforeGrid}

      <MonthOverview
        /* Remount on a month change: the selected day and any open popover
           belong to the month that was on screen, not the one arriving. */
        key={isWeek ? `week-${weekStart(weekAnchor)}` : month}
        month={month}
        days={days}
        today={today}
        entries={entries}
        staff={staff}
        detailHrefBase={detailHrefBase}
        showAmounts={showAmounts}
      />
    </>
  );
}

/** A compact projection: what a calendar entry draws and nothing else. */
export function toMonthEntries(
  appointments: Array<MonthEntry & Record<string, unknown>>,
): MonthEntry[] {
  return appointments.map((a) => ({
    id: a.id,
    date: a.date,
    startTime: a.startTime,
    customerName: a.customerName,
    staffId: a.staffId,
    staffName: a.staffName,
    staffColourIndex: a.staffColourIndex,
    totalAmount: a.totalAmount,
    isLargeJob: a.isLargeJob,
  }));
}
