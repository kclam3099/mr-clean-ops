"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { compactMoney } from "@/lib/pricing/duration";
import { colourAt, staffBadgeLetter } from "@/lib/agenda/staff-colour";
import { useT } from "@/components/i18n/I18nProvider";

/**
 * The dashboard's month operations overview.
 *
 * The question on logging in is "what does the month look like" — which days
 * are busy, where work clusters, which days are still open. So this is a
 * calendar, not a list of cards: thin rules, compact type, and entries that
 * read like calendar entries rather than components.
 *
 * It is deliberately NOT the /calendar page. That one is a staff x day
 * scheduling matrix for deciding who does what; this one is a month-shaped
 * answer to "how full are we". Overlapping data, different questions.
 *
 * CLIENT component, on purpose. Month navigation is server-rendered (it changes
 * which rows are fetched), but three things here are pure view state and should
 * not cost a round trip: opening a day's overflow, picking a day on mobile, and
 * closing either. It receives a COMPACT projection — no address, phone or
 * remarks — so the month payload carries only what a cell draws.
 *
 * Every figure comes from the rows the server already received through RLS.
 * There is no aggregate query, so a Shared-Team-only Master's totals are
 * Shared-Team totals by construction.
 */

export type MonthEntry = {
  id: string;
  date: string;
  startTime: string;
  customerName: string;
  staffId: string | null;
  staffName: string | null;
  staffColourIndex: number;
  totalAmount: number | null;
  isLargeJob: boolean;
  /** Where the job is. Only the staff calendar sends it, in place of money. */
  areaCity?: string | null;
};

/** A person on the roster, so a day can say "no appointment" for them. */
export type MonthStaff = { id: string; name: string; colourIndex: number };

/** How many entries a desktop cell shows before collapsing into "+N more". */
const VISIBLE_PER_CELL = 3;

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function dayNumber(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

/** "1,250" or "1.3k": a day total small enough for a phone-width date cell. */
function shortAmount(amount: number): string {
  if (amount >= 10000) return `${(amount / 1000).toFixed(0)}k`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(amount));
}

function longDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    weekday: "long", day: "numeric", month: "short", timeZone: "UTC",
  }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}

export function MonthOverview({
  month,
  days,
  today,
  entries,
  staff = [],
  detailHrefBase,
  showAmounts = true,
}: {
  /** Active month as "YYYY-MM". Days outside it are shown, de-emphasised. */
  month: string;
  /** The dates of the grid, in order, Monday first: 42 for a month, 7 for a week. */
  days: string[];
  today: string;
  entries: MonthEntry[];
  /** Everyone the selected-day agenda lists, booked or not. */
  staff?: MonthStaff[];
  /** Detail links are built here because a function cannot cross to a client. */
  detailHrefBase: string;
  /**
   * Day totals and per-job prices. Off on the staff calendar, which shows each
   * job's area instead — where to go, not what it is worth.
   */
  showAmounts?: boolean;
}) {
  // Seven dates is a week, forty-two is a month. Derived rather than passed,
  // so the two cannot disagree about which one is being drawn.
  const { t, lang, locale } = useT();
  const isWeek = days.length <= 7;
  const visiblePerCell = isWeek ? 8 : VISIBLE_PER_CELL;

  const [openDay, setOpenDay] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>(() =>
    days.includes(today) ? today : (days.find((d) => d.slice(0, 7) === month) ?? (days[0] as string)),
  );
  const gridRef = useRef<HTMLDivElement>(null);

  // The selected day belongs to the month being shown, which the caller
  // guarantees with key={month}: paging to October remounts this and the
  // initialisers above run again. Syncing it in an effect instead would render
  // October's grid once with September's agenda under it, then correct itself.

  // Dismiss the overflow popover the way every popover should be dismissable.
  useEffect(() => {
    if (!openDay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenDay(null); };
    const onDown = (e: MouseEvent) => {
      if (!gridRef.current?.contains(e.target as Node)) setOpenDay(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [openDay]);

  const byDate = new Map<string, MonthEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }

  const openQuickAdd = (date: string) => {
    // The Quick Add sheet is owned by the floating button in the shell, so the
    // date travels to it rather than a second sheet being mounted here. One
    // parser, one form, one save path.
    window.dispatchEvent(new CustomEvent("quickadd:open", { detail: { date } }));
  };

  // What the day is worth, from the same rows the cell draws — never a separate
  // aggregate, so it cannot include work this Master is not allowed to see.
  const dayTotal = (date: string): number =>
    (byDate.get(date) ?? []).reduce((sum, e) => sum + (e.totalAmount ?? 0), 0);

  const selectedEntries = byDate.get(selectedDay) ?? [];
  const selectedTotal = dayTotal(selectedDay);
  const selectedGroups = staffGroups(staff, selectedEntries);

  return (
    <div ref={gridRef} data-month-grid={month}>
      {/* ---------------- desktop: the month grid ---------------- */}
      <div className="hidden overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:block">
        <div className="grid grid-cols-7 border-b border-line bg-brand">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="px-2 py-2.5 text-center text-sm font-bold tracking-wider text-white"
            >
              {t(w)}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {days.map((date, i) => {
            const list = byDate.get(date) ?? [];
            const outside = date.slice(0, 7) !== month;
            const isToday = date === today;
            const hidden = list.length - visiblePerCell;
            return (
              <div
                key={date}
                data-day-cell={date}
                data-outside-month={outside ? "true" : undefined}
                className={`group relative border-b border-r border-line/70 p-1.5
                            ${isWeek ? "min-h-[18rem]" : "min-h-[7.5rem]"}
                            ${i % 7 === 6 ? "border-r-0" : ""}
                            ${isWeek || i >= 35 ? "border-b-0" : ""}
                            ${outside ? "bg-sunken/60" : ""}
                            ${isToday ? "bg-amber/15 ring-2 ring-inset ring-gold" : ""}`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    data-today={isToday ? "true" : undefined}
                    className={
                      isToday
                        ? "flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1.5 text-[12px] font-bold text-white"
                        : `px-0.5 text-[11px] font-semibold ${outside ? "text-ink-faint" : "text-ink"}`
                    }
                  >
                    {dayNumber(date)}
                  </span>
                  {showAmounts && list.length > 0 ? (
                    <span
                      data-day-total={date}
                      title={list.length === 1
                        ? t("{count} appointment booked", { count: list.length })
                        : t("{count} appointments booked", { count: list.length })}
                      className={`ml-auto mr-0.5 rounded px-1 font-semibold tabular-nums
                                  ${isWeek ? "py-0.5 text-[12px]" : "text-[10px]"}
                                  ${outside && !isWeek ? "text-ink-faint" : "bg-brand/10 text-brand"}`}
                    >
                      {compactMoney(dayTotal(date))}
                    </span>
                  ) : null}
                  {/* Revealed on hover, but always reachable by keyboard. */}
                  <button
                    type="button"
                    data-add-on={date}
                    onClick={() => openQuickAdd(date)}
                    aria-label={t("New appointment on {date}", { date: longDay(date, locale) })}
                    className="cursor-pointer rounded text-[15px] leading-none text-ink-faint opacity-0
                               transition hover:bg-brand/10 hover:text-brand focus-visible:opacity-100
                               group-hover:opacity-100"
                  >
                    <span aria-hidden="true" className="px-1">+</span>
                  </button>
                </div>

                <div className="space-y-0.5">
                  {list.slice(0, visiblePerCell).map((e) => (
                    <MonthEntryRow key={e.id} entry={e} href={`${detailHrefBase}/${e.id}`} />
                  ))}
                </div>

                {hidden > 0 ? (
                  <button
                    type="button"
                    data-more-on={date}
                    onClick={() => setOpenDay(openDay === date ? null : date)}
                    aria-expanded={openDay === date}
                    className="mt-0.5 w-full rounded px-1 py-0.5 text-left text-[10px] font-medium
                               text-ink-muted hover:bg-sunken hover:text-brand"
                  >
                    {t("+{count} more", { count: hidden })}
                  </button>
                ) : null}

                {openDay === date ? (
                  <div
                    data-day-popover={date}
                    role="dialog"
                    aria-label={t("Appointments on {date}", { date: longDay(date, locale) })}
                    className="absolute left-1 right-1 top-8 z-30 rounded-lg border border-line
                               bg-white p-2 shadow-xl"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold text-ink">{longDay(date, locale)}</p>
                      <button
                        type="button"
                        onClick={() => setOpenDay(null)}
                        aria-label={t("Close")}
                        className="cursor-pointer rounded px-1 text-xs text-ink-faint hover:bg-sunken hover:text-brand"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="max-h-56 space-y-0.5 overflow-y-auto">
                      {list.map((e) => (
                        <MonthEntryRow key={e.id} entry={e} href={`${detailHrefBase}/${e.id}`} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------- below lg: date grid + selected-day agenda ----------------
          A seven-column month grid does not survive being squeezed to a phone:
          either it scrolls sideways or every entry becomes unreadable. So the
          grid keeps its shape and loses its entries, and the day you tap opens
          underneath it. */}
      <div className="lg:hidden">
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="grid grid-cols-7 border-b border-line bg-brand">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1.5 text-center text-xs font-bold tracking-wider text-white">
                {lang === "zh" ? t(w).slice(-1) : w.slice(0, 1)}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((date) => {
              const count = (byDate.get(date) ?? []).length;
              const outside = date.slice(0, 7) !== month;
              const isToday = date === today;
              const isSelected = date === selectedDay;
              return (
                <button
                  key={date}
                  type="button"
                  data-mini-day={date}
                  data-selected={isSelected ? "true" : undefined}
                  onClick={() => setSelectedDay(date)}
                  aria-pressed={isSelected}
                  aria-label={`${count === 1
                    ? t("{date}, {count} appointment", { date: longDay(date, locale), count })
                    : t("{date}, {count} appointments", { date: longDay(date, locale), count })}${
                    showAmounts && count > 0 ? t(", {amount} booked", { amount: compactMoney(dayTotal(date)) }) : ""}`}
                  className={`flex min-h-[2.75rem] cursor-pointer flex-col items-center justify-center
                              gap-0.5 border-b border-r border-line/70 py-1 transition
                              last:border-r-0
                              ${isToday && !isSelected ? "bg-amber/20" : ""}
                              ${isSelected ? "bg-brand/10 ring-2 ring-inset ring-brand" : "hover:bg-sunken"}`}
                >
                  <span
                    data-today={isToday ? "true" : undefined}
                    className={
                      isToday
                        ? "flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1 text-[12px] font-bold text-white"
                        : `text-[11px] font-semibold ${outside ? "text-ink-faint" : "text-ink"}`
                    }
                  >
                    {dayNumber(date)}
                  </span>
                  {/* The day's booked total, in the box itself — the number a
                      Master scans the week for. Bare digits, no "RM": a phone
                      cell is ~48px and the currency is the same in every one. */}
                  {showAmounts ? (
                    <span
                      data-day-total={date}
                      aria-hidden="true"
                      className={`h-3 text-[9px] font-semibold leading-3 tabular-nums
                                  ${outside && !isWeek ? "text-ink-faint" : "text-brand"}`}
                    >
                      {count > 0 ? shortAmount(dayTotal(date)) : ""}
                    </span>
                  ) : (
                    // No money on the staff calendar: one dot per job instead.
                    <span className="flex h-3 items-center gap-[2px]" aria-hidden="true">
                      {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
                        <span key={i} className="h-1.5 w-1.5 rounded-full bg-brand/70" />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3" data-day-agenda={selectedDay}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">
              {longDay(selectedDay, locale)}
              {showAmounts && selectedEntries.length > 0 ? (
                <span data-selected-day-total className="ml-2 font-semibold tabular-nums text-brand">
                  {compactMoney(selectedTotal)}
                </span>
              ) : null}
            </h2>
            <button
              type="button"
              data-add-on={selectedDay}
              onClick={() => openQuickAdd(selectedDay)}
              /* min-h-8: a 24px control is a miss on a phone. The desktop grid's
                 + is a hover affordance beside a large cell; this one is the
                 only way to add from the agenda, so it gets a real tap target. */
              className="flex min-h-8 items-center rounded-lg border border-line bg-white px-3
                         text-xs font-medium text-ink transition hover:bg-sunken"
            >
              {t("+ New appointment")}
            </button>
          </div>
          {selectedGroups.length === 0 ? (
            // Says nothing about availability: hidden work and physical
            // conflicts are invisible here by design, so "free" would be a lie.
            <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center
                          text-xs text-ink-faint">
              {t("Nothing scheduled.")}
            </p>
          ) : (
            // One block per person, everyone on the roster included, so "who
            // has nothing this day" is read off the list, not worked out.
            <div className="space-y-2">
              {selectedGroups.map((g) => (
                <div key={g.key} data-day-staff={g.key}
                  className="overflow-hidden rounded-lg border border-line bg-white">
                  <div className="flex items-center gap-1.5 border-b border-line/70 bg-sunken/60 px-2 py-1.5">
                    {g.name ? (
                      <span aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                                    text-[10px] font-bold text-white ${colourAt(g.colourIndex).solid}`}>
                        {staffBadgeLetter(g.name)}
                      </span>
                    ) : null}
                    <span className={`truncate text-xs font-semibold
                                      ${g.name ? colourAt(g.colourIndex).text : "text-ink-muted"}`}>
                      {g.name ?? t("Unassigned")}
                    </span>
                    {g.entries.length > 0 ? (
                      <span className="ml-auto shrink-0 text-[11px] font-semibold tabular-nums text-ink-muted">
                        {g.entries.length}
                        {showAmounts
                          ? ` · ${compactMoney(g.entries.reduce((sum, e) => sum + (e.totalAmount ?? 0), 0))}`
                          : ""}
                      </span>
                    ) : null}
                  </div>
                  {g.entries.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-ink-faint">{t("No appointment")}</p>
                  ) : (
                    <div className="space-y-1 p-1">
                      {g.entries.map((e) => (
                        <MonthEntryRow key={e.id} entry={e} href={`${detailHrefBase}/${e.id}`} roomy hideStaff />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One calendar entry: time, customer, staff, amount. Nothing else.
 *
 * Address, phone, remarks, duration and the Call/WhatsApp/Directions actions
 * all live on the appointment itself. Repeating them here is what turned the
 * old dashboard into 200px of chrome per booking.
 */
/**
 * The selected day, one group per person: every roster member in roster order
 * (empty ones included), then anyone booked who is not on the roster — e.g. a
 * person since removed — and unassigned work last.
 */
function staffGroups(staff: MonthStaff[], dayEntries: MonthEntry[]) {
  type Group = { key: string; name: string | null; colourIndex: number; entries: MonthEntry[] };
  const groups = new Map<string, Group>();
  for (const s of staff) groups.set(s.id, { key: s.id, name: s.name, colourIndex: s.colourIndex, entries: [] });
  for (const e of dayEntries) {
    const key = e.staffId ?? "unassigned";
    let g = groups.get(key);
    if (!g) {
      g = { key, name: e.staffId ? e.staffName : null, colourIndex: e.staffColourIndex, entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.key !== "unassigned"), ...all.filter((g) => g.key === "unassigned")];
}

function MonthEntryRow({
  entry, href, roomy = false, hideStaff = false,
}: {
  entry: MonthEntry;
  href: string;
  roomy?: boolean;
  /** Inside a per-person group the name is already the heading. */
  hideStaff?: boolean;
}) {
  const { t } = useT();
  return (
    <Link
      href={href}
      data-appointment-row={entry.id}
      className={`block cursor-pointer rounded border-l-2 border-brand/40 bg-sunken transition
                  hover:border-brand hover:bg-brand/10
                  ${roomy ? "px-2 py-1.5 text-xs" : "px-1 py-0.5 text-[11px]"}`}
    >
      <span className="flex items-baseline gap-1">
        <span className="shrink-0 font-semibold tabular-nums text-ink">{entry.startTime}</span>
        <span className="truncate text-ink">{entry.customerName}</span>
        {/* The badge sits on the TIME line, where there is nearly always slack.
            On the staff line it stole width from the staff name, which is the
            one thing on an entry that must stay readable — "TEST_JA…" tells
            you nothing about who is going. */}
        {entry.isLargeJob ? (
          <span
            data-large-job={entry.id}
            className="ml-auto shrink-0 self-center rounded bg-gold px-1 text-[9px] font-bold
                       tracking-wide text-brand-900"
          >
            {t("LARGE")}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-[3px] truncate text-ink-muted">
        {/* A coloured initial AND the name. The disc is what makes a month of
            cells scannable — you learn the colour once and stop reading — but
            it is an accelerator, not the message: colour is not readable to
            everyone and does not survive a screenshot pasted into WhatsApp,
            so the name stays. */}
        {entry.staffName && !hideStaff ? (
          <>
            <span
              aria-hidden
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full
                          text-[8px] font-bold leading-none text-white
                          ${colourAt(entry.staffColourIndex).solid}`}
            >
              {staffBadgeLetter(entry.staffName)}
            </span>
            <span className={`truncate font-medium ${colourAt(entry.staffColourIndex).text}`}>
              {entry.staffName}
            </span>
          </>
        ) : null}
        {entry.totalAmount !== null ? (
          <>
            {entry.staffName && !hideStaff ? <span aria-hidden="true">·</span> : null}
            <span className="shrink-0 tabular-nums">{compactMoney(entry.totalAmount)}</span>
          </>
        ) : null}
        {/* The staff calendar sends the area instead of the price. */}
        {entry.areaCity ? (
          <>
            {entry.staffName && !hideStaff ? <span aria-hidden="true">·</span> : null}
            <span data-entry-area className="truncate">{entry.areaCity}</span>
          </>
        ) : null}
      </span>
    </Link>
  );
}
