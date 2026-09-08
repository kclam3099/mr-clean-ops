"use client";

import { useState } from "react";
import Link from "next/link";
import { findTimesAction, type AvailabilitySlot } from "@/lib/availability/queries";
import { MAX_RANGE_DAYS } from "@/lib/availability/constants";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import type { AppError } from "@/lib/errors/appError";

/**
 * "When can we fit this customer in?"
 *
 * Results are available rows only — there is no "why not" for a time that is
 * missing, because a hidden appointment is exactly what removes it.
 *
 * The suggestions are STANDARD-JOB only: the RPC uses the configured default
 * duration, not this customer's price. That is stated in the caption, and it
 * is why every result still has to survive create_appointment.
 */
export function AvailabilityFinder({
  staff,
  scopeValue,
  businessToday,
  maxDate,
  presets,
}: {
  staff: Array<{ id: string; name: string }>;
  scopeValue: string | null;
  businessToday: string;
  maxDate: string;
  presets: Array<{ label: string; from: string; to: string }>;
}) {
  const [selected, setSelected] = useState<string[]>(staff.map((s) => s.id));
  const [from, setFrom] = useState(presets[0]?.from ?? businessToday);
  const [to, setTo] = useState(presets[0]?.to ?? businessToday);
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function search(nextFrom = from, nextTo = to) {
    setPending(true);
    setError(null);
    const result = await findTimesAction({
      scopeValue: scopeValue ?? undefined,
      staffIds: selected,
      from: nextFrom,
      to: nextTo,
    });
    setPending(false);
    if (result.status === "error") { setError(result.error); setSlots(null); return; }
    setSlots(result.slots);
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Team members</legend>
          <div className="flex flex-wrap gap-2">
            {staff.map((s) => {
              const on = selected.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  aria-pressed={on}
                  data-staff-chip
                  className={`min-h-11 rounded-full border px-4 text-sm font-medium transition ${
                    on
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                  }`}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
          {selected.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No one selected — searching everyone in this view.
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">When</legend>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                data-range-preset
                onClick={() => { setFrom(p.from); setTo(p.to); void search(p.from, p.to); }}
                className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm
                           text-slate-700 transition hover:border-slate-400"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-slate-600">From</span>
              <input
                type="date" value={from} min={businessToday} max={maxDate}
                onChange={(e) => setFrom(e.target.value)}
                className="min-h-11 rounded-lg border border-slate-300 px-3 text-base"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-600">To</span>
              <input
                type="date" value={to} min={from} max={maxDate}
                onChange={(e) => setTo(e.target.value)}
                className="min-h-11 rounded-lg border border-slate-300 px-3 text-base"
              />
            </label>
            <button
              type="button"
              onClick={() => void search()}
              disabled={pending}
              className="min-h-11 rounded-lg bg-slate-900 px-5 text-sm font-medium text-white
                         transition hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? "Finding…" : "Find times"}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Up to {MAX_RANGE_DAYS} days at a time.
          </p>
        </fieldset>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {pending ? (
        <p className="text-sm text-slate-500" aria-busy="true">Checking availability…</p>
      ) : slots === null ? (
        <p className="text-sm text-slate-500">
          Choose who and when, then press Find times.
        </p>
      ) : slots.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          No suggested times in this range. You can still book a custom time.
        </p>
      ) : (
        <Results slots={slots} scopeValue={scopeValue} />
      )}

      <p className="text-xs text-slate-500">
        Suggested for a standard job. Final availability is confirmed when saving.
      </p>
    </div>
  );
}

function Results({
  slots, scopeValue,
}: {
  slots: AvailabilitySlot[];
  scopeValue: string | null;
}) {
  const bookHref = (s: AvailabilitySlot) => {
    const q = new URLSearchParams({
      staff: s.staffId, date: s.date, time: s.time, return: "availability",
    });
    // "all" is a virtual view, never a workspace id — pass nothing and let the
    // booking form require a real one.
    if (scopeValue && scopeValue !== "all") q.set("ws", scopeValue);
    return `/appointments/new?${q.toString()}`;
  };

  return (
    <div>
      <p className="mb-2 text-sm text-slate-600">
        {slots.length} suggested time{slots.length === 1 ? "" : "s"}
      </p>
      <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {slots.map((s) => (
          <li key={`${s.staffId}-${s.date}-${s.time}`}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium tabular-nums text-slate-900">
                {formatDay(s.date)} · {s.time}
              </p>
              <p className="text-sm text-slate-600">{s.staffName}</p>
            </div>
            <Link
              href={bookHref(s)}
              data-book-slot
              className="flex min-h-11 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium
                         text-white transition hover:bg-slate-800"
            >
              Book this time
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
