"use client";

/**
 * Standard-job availability suggestions.
 *
 * These come from `find_available_slots`, which takes NO amount, duration or
 * buffer — see migration 0007. The suggestions therefore do NOT change when the
 * job total changes, and must not be re-fetched on item edits. Feeding the
 * amount back in is exactly the oracle that 0007 closed.
 *
 * The consequence is deliberate and is stated to the user: a suggested time can
 * still be refused at save time once the real job is priced.
 */
export function AvailabilitySuggestions({
  slots,
  loading,
  selectedTime,
  onPick,
  disabled,
}: {
  slots: string[];
  loading: boolean;
  selectedTime: string;
  onPick: (time: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {loading ? (
          <p className="text-sm text-slate-500">Checking availability…</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-slate-500">
            No suggested times available. You can still enter a time below.
          </p>
        ) : (
          slots.map((time) => {
            const active = selectedTime === time;
            return (
              <button
                key={time}
                type="button"
                onClick={() => onPick(time)}
                disabled={disabled}
                aria-pressed={active}
                className={`rounded-lg border px-4 py-2.5 font-mono text-sm tabular-nums transition ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-800 hover:border-slate-400"
                }`}
              >
                {time}
              </button>
            );
          })
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Available when checked — final availability is confirmed when saving.
      </p>
    </div>
  );
}
