"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { compactMoney } from "@/lib/pricing/duration";

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
  staffName: string | null;
  totalAmount: number | null;
  isLargeJob: boolean;
};

/** How many entries a desktop cell shows before collapsing into "+N more". */
const VISIBLE_PER_CELL = 3;

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function dayNumber(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "short", timeZone: "UTC",
  }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}

export function MonthOverview({
  month,
  days,
  today,
  entries,
  detailHrefBase,
}: {
  /** Active month as "YYYY-MM". Days outside it are shown, de-emphasised. */
  month: string;
  /** The 42 dates of the grid, in order, Sunday first. */
  days: string[];
  today: string;
  entries: MonthEntry[];
  /** Detail links are built here because a function cannot cross to a client. */
  detailHrefBase: string;
}) {
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

  const selectedEntries = byDate.get(selectedDay) ?? [];

  return (
    <div ref={gridRef} data-month-grid={month}>
      {/* ---------------- desktop: the month grid ---------------- */}
      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white lg:block">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="px-2 py-1.5 text-center text-[10px] font-semibold tracking-widest text-slate-500"
            >
              {w}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {days.map((date, i) => {
            const list = byDate.get(date) ?? [];
            const outside = date.slice(0, 7) !== month;
            const isToday = date === today;
            const hidden = list.length - VISIBLE_PER_CELL;
            return (
              <div
                key={date}
                data-day-cell={date}
                data-outside-month={outside ? "true" : undefined}
                className={`group relative min-h-[7.5rem] border-b border-r border-slate-100 p-1.5
                            ${i % 7 === 6 ? "border-r-0" : ""}
                            ${i >= 35 ? "border-b-0" : ""}
                            ${outside ? "bg-slate-50/60" : ""}`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    data-today={isToday ? "true" : undefined}
                    className={
                      isToday
                        ? "flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900 px-1 text-[11px] font-semibold text-white"
                        : `px-0.5 text-[11px] font-medium ${outside ? "text-slate-400" : "text-slate-600"}`
                    }
                  >
                    {dayNumber(date)}
                  </span>
                  {/* Revealed on hover, but always reachable by keyboard. */}
                  <button
                    type="button"
                    data-add-on={date}
                    onClick={() => openQuickAdd(date)}
                    aria-label={`New appointment on ${longDay(date)}`}
                    className="rounded text-[13px] leading-none text-slate-400 opacity-0 transition
                               hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100
                               group-hover:opacity-100"
                  >
                    <span aria-hidden="true" className="px-1">+</span>
                  </button>
                </div>

                <div className="space-y-0.5">
                  {list.slice(0, VISIBLE_PER_CELL).map((e) => (
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
                               text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  >
                    +{hidden} more
                  </button>
                ) : null}

                {openDay === date ? (
                  <div
                    data-day-popover={date}
                    role="dialog"
                    aria-label={`Appointments on ${longDay(date)}`}
                    className="absolute left-1 right-1 top-8 z-30 rounded-lg border border-slate-200
                               bg-white p-2 shadow-xl"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold text-slate-900">{longDay(date)}</p>
                      <button
                        type="button"
                        onClick={() => setOpenDay(null)}
                        aria-label="Close"
                        className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1 text-center text-[10px] font-semibold text-slate-500">
                {w.slice(0, 1)}
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
                  aria-label={`${longDay(date)}, ${count} appointment${count === 1 ? "" : "s"}`}
                  className={`flex min-h-[2.75rem] flex-col items-center justify-center gap-0.5 border-b
                              border-r border-slate-100 py-1 transition last:border-r-0
                              ${isSelected ? "bg-slate-900/5 ring-1 ring-inset ring-slate-900" : "hover:bg-slate-50"}`}
                >
                  <span
                    data-today={isToday ? "true" : undefined}
                    className={
                      isToday
                        ? "flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900 px-1 text-[11px] font-semibold text-white"
                        : `text-[11px] font-medium ${outside ? "text-slate-400" : "text-slate-700"}`
                    }
                  >
                    {dayNumber(date)}
                  </span>
                  {/* Density, not a number: three dots read faster than "3" and
                      do not compete with the date. */}
                  <span className="flex h-1 items-center gap-[2px]" aria-hidden="true">
                    {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
                      <span key={i} className="h-1 w-1 rounded-full bg-slate-400" />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3" data-day-agenda={selectedDay}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{longDay(selectedDay)}</h2>
            <button
              type="button"
              data-add-on={selectedDay}
              onClick={() => openQuickAdd(selectedDay)}
              /* min-h-8: a 24px control is a miss on a phone. The desktop grid's
                 + is a hover affordance beside a large cell; this one is the
                 only way to add from the agenda, so it gets a real tap target. */
              className="flex min-h-8 items-center rounded-lg border border-slate-300 bg-white px-3
                         text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              + New appointment
            </button>
          </div>
          {selectedEntries.length === 0 ? (
            // Says nothing about availability: hidden work and physical
            // conflicts are invisible here by design, so "free" would be a lie.
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center
                          text-xs text-slate-400">
              Nothing scheduled.
            </p>
          ) : (
            <div className="space-y-1">
              {selectedEntries.map((e) => (
                <MonthEntryRow key={e.id} entry={e} href={`${detailHrefBase}/${e.id}`} roomy />
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
function MonthEntryRow({
  entry, href, roomy = false,
}: {
  entry: MonthEntry;
  href: string;
  roomy?: boolean;
}) {
  return (
    <Link
      href={href}
      data-appointment-row={entry.id}
      className={`block rounded border-l-2 border-slate-300 bg-slate-50 transition
                  hover:border-slate-900 hover:bg-slate-100
                  ${roomy ? "px-2 py-1.5 text-xs" : "px-1 py-0.5 text-[11px]"}`}
    >
      <span className="flex items-baseline gap-1">
        <span className="shrink-0 font-semibold tabular-nums text-slate-900">{entry.startTime}</span>
        <span className="truncate text-slate-900">{entry.customerName}</span>
        {/* The badge sits on the TIME line, where there is nearly always slack.
            On the staff line it stole width from the staff name, which is the
            one thing on an entry that must stay readable — "TEST_JA…" tells
            you nothing about who is going. */}
        {entry.isLargeJob ? (
          <span
            data-large-job={entry.id}
            className="ml-auto shrink-0 self-center rounded bg-amber-100 px-1 text-[9px] font-bold
                       tracking-wide text-amber-800"
          >
            LARGE
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-[3px] truncate text-slate-500">
        {/* Staff is TEXT, never colour alone — colour is not readable to
            everyone and does not survive a screenshot pasted into WhatsApp. */}
        {entry.staffName ? <span className="truncate">{entry.staffName}</span> : null}
        {entry.totalAmount !== null ? (
          <>
            {entry.staffName ? <span aria-hidden="true">·</span> : null}
            <span className="shrink-0 tabular-nums">{compactMoney(entry.totalAmount)}</span>
          </>
        ) : null}
      </span>
    </Link>
  );
}
