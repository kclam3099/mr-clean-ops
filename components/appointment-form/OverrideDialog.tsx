"use client";

import { useState } from "react";
import type { AppError } from "@/lib/errors/appError";

/**
 * Large-job override confirmation. Masters only, and only ever reached from a
 * LARGE_JOB_OVERRIDE_REQUIRED result.
 *
 * STAFF_UNAVAILABLE must never open this: that code means the blocking
 * appointment is hidden from this caller, and offering to override something
 * they cannot see would both leak its existence and be refused by the database.
 *
 * There is no persistent toggle. The reason is required, the acknowledgement is
 * explicit, and both are discarded after the attempt — each violating booking
 * needs its own exception, which is what the database enforces.
 */
export function OverrideDialog({
  error,
  onConfirm,
  onCancel,
  pending,
}: {
  error: AppError;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const ready = reason.trim().length > 0 && acknowledged && !pending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="override-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 id="override-title" className="text-base font-semibold text-slate-900">
          Master approval needed
        </h2>
        <p className="mt-2 text-sm text-slate-600">{error.message}</p>
        {error.detail.blockingTime ? (
          <p className="mt-1 text-sm text-slate-600">
            The large job starts at{" "}
            <span className="font-mono tabular-nums">{error.detail.blockingTime}</span>.
          </p>
        ) : null}

        <label htmlFor="override-reason" className="mt-4 block text-sm font-medium text-slate-700">
          Reason for the exception
        </label>
        <textarea
          id="override-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="e.g. Nearby easy job, will still finish on time"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900
                     placeholder:text-slate-400 focus:border-slate-900 focus:outline-none
                     focus:ring-1 focus:ring-slate-900"
        />

        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            I approve this single booking as an exception. It is recorded against my name.
          </span>
        </label>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            Choose another time
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={!ready}
            className="flex-1 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white
                       transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Approve and save"}
          </button>
        </div>
      </div>
    </div>
  );
}
