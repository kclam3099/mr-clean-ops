"use client";

import { useT } from "@/components/i18n/I18nProvider";
import type { TFunc } from "@/lib/i18n/core";

/**
 * Confirmation for recording a job that already happened.
 *
 * This is deliberately NOT styled as an error. Recording history is a normal
 * part of running the business — a customer is served at 2pm and the booking is
 * entered at 4pm — so the tone is "are you sure", not "you did something wrong".
 * Amber rather than red, and the confirming action is the primary button.
 *
 * The UI is not the control. `create_appointment` refuses a past datetime
 * unless the request carries p_confirm_past (migration 0010), so skipping this
 * dialog gets the booking refused rather than silently recorded.
 */
export function PastAppointmentDialog({
  date,
  time,
  onConfirm,
  onCancel,
  pending,
}: {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const { t, locale } = useT();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="past-appointment-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 id="past-appointment-title" className="text-base font-semibold text-slate-900">
          {t("Past appointment")}
        </h2>

        <p className="mt-2 text-sm text-slate-600">{t("This appointment is in the past:")}</p>

        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm
                      font-medium text-amber-900">
          {formatLong(date, locale)} · {formatTime(time, t)}
        </p>

        <p className="mt-3 text-sm text-slate-600">{t("Record this appointment anyway?")}</p>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            {t("Go back")}
          </button>
          <button
            type="button"
            data-confirm-past
            onClick={onConfirm}
            disabled={pending}
            className="flex-1 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white
                       transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? t("Recording…") : t("Record past appointment")}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatLong(iso: string, locale: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(d);
}

function formatTime(hhmm: string, t: TFunc): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  const hour = (h as number) % 12 === 0 ? 12 : (h as number) % 12;
  const vars = { hour, min: String(m).padStart(2, "0") };
  return (h as number) < 12 ? t("{hour}:{min} AM", vars) : t("{hour}:{min} PM", vars);
}
