"use client";

import { useEffect, useState } from "react";
import { findCustomerAvailabilityAction } from "@/lib/availability/queries";
import { buildCustomerMessage, type RangePreset } from "@/lib/availability/customer-message";
import { MAX_RANGE_DAYS } from "@/lib/availability/constants";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import type { AppError } from "@/lib/errors/appError";

/**
 * "When are you available?" — answered as a message, not a report.
 *
 * The owner's real task is to reply to a customer on WhatsApp, so the output is
 * the exact text to paste, with one button to copy it. Choosing WHEN is the
 * only decision; choosing WHO is not, because the customer does not care and
 * the message never names anyone.
 */
export function CustomerAvailability({
  presets,
  initialPreset,
  initialMessage,
  businessToday,
  maxDate,
}: {
  presets: Array<{ key: RangePreset; label: string; from: string; to: string }>;
  initialPreset: RangePreset;
  /** Rendered on the server, so the answer is on screen at first paint and the
   *  owner never waits for a round trip to read the commonest case. */
  initialMessage: string;
  businessToday: string;
  maxDate: string;
}) {
  const initial = presets.find((p) => p.key === initialPreset) ?? presets[0]!;
  const [preset, setPreset] = useState<RangePreset>(initial.key);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [error, setError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  async function search(nextPreset: RangePreset, nextFrom: string, nextTo: string) {
    setPending(true);
    setError(null);
    setCopied(false);
    const result = await findCustomerAvailabilityAction({ from: nextFrom, to: nextTo });
    setPending(false);
    if (result.status === "error") { setError(result.error); setMessage(null); return; }
    setMessage(buildCustomerMessage(result.slots, nextPreset));
  }

  async function copy() {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      // Clipboard permission can be refused; a textarea fallback still lets the
      // owner copy without hand-selecting the text.
      const ta = document.getElementById("customer-message-text") as HTMLTextAreaElement | null;
      ta?.select();
      try { document.execCommand("copy"); setCopied(true); } catch { /* leave it selected */ }
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-sm font-medium text-slate-700">When</p>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              data-range-preset={p.key}
              aria-pressed={preset === p.key}
              onClick={() => {
                setPreset(p.key); setFrom(p.from); setTo(p.to);
                void search(p.key, p.from, p.to);
              }}
              className={`min-h-11 rounded-lg border px-4 text-sm font-medium transition ${
                preset === p.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <details className="text-sm">
          <summary className="-my-2 cursor-pointer py-2 text-slate-600">Custom dates</summary>
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
              onClick={() => { setPreset("custom"); void search("custom", from, to); }}
              disabled={pending}
              className="min-h-11 rounded-lg bg-slate-900 px-5 text-sm font-medium text-white
                         transition hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? "Checking…" : "Check"}
            </button>
            <p className="w-full text-xs text-slate-500">Up to {MAX_RANGE_DAYS} days at a time.</p>
          </div>
        </details>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {pending && message === null ? (
        <p className="text-sm text-slate-500" aria-busy="true">Checking availability…</p>
      ) : message !== null ? (
        <div className="rounded-2xl border border-slate-200 bg-white">
          {/* A textarea rather than a <pre>: it keeps the exact text selectable
              and gives the clipboard fallback something to select. Read-only,
              so the copied text is always what was generated. */}
          <textarea
            id="customer-message-text"
            data-customer-message
            readOnly
            value={message}
            rows={Math.min(16, message.split("\n").length + 1)}
            className="w-full resize-none rounded-t-2xl border-0 bg-transparent px-4 py-4 text-base
                       leading-relaxed text-slate-900 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span aria-live="polite" className="text-sm text-slate-500">
              {copied ? "Copied" : "Ready to send"}
            </span>
            <button
              type="button"
              data-copy-message
              onClick={() => void copy()}
              className="min-h-11 rounded-lg bg-slate-900 px-5 text-sm font-medium text-white
                         transition hover:bg-slate-800"
            >
              {copied ? "Copied" : "Copy message"}
            </button>
          </div>
        </div>
      ) : null}

      <p className="text-xs text-slate-500">
        Suggested for a standard job. Final availability is confirmed when saving.
      </p>
    </div>
  );
}
