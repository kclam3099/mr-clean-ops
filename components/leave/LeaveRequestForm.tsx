"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestLeaveAction } from "@/lib/leave/actions";
import type { ActionResult } from "@/lib/appointments/lifecycle-actions";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useT } from "@/components/i18n/I18nProvider";

/**
 * Ask for leave: dates, full day or part of one, an optional reason. The
 * request goes to the Masters of this person's workspaces; nobody is chosen
 * here, so a staff member cannot route it to a Master who does not manage them.
 */
export function LeaveRequestForm({ today }: { today: string }) {
  const { t } = useT();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [part, setPart] = useState(false);
  const [start, setStart] = useState(today);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const fieldError = (n: string) => {
    const msg = result?.status === "error" ? result.fields?.[n] : undefined;
    return msg ? t(msg) : undefined;
  };

  return (
    <form
      ref={formRef}
      data-leave-form
      className="space-y-4 rounded-xl border border-line bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const fd = new FormData(e.currentTarget);
        // A part day is one date; the end date input is hidden, so mirror it.
        if (part) fd.set("endDate", String(fd.get("startDate") ?? ""));
        startTransition(async () => {
          const res = await requestLeaveAction(fd);
          setResult(res);
          if (res.status === "success") {
            setSent(true);
            formRef.current?.reset();
            setPart(false);
            setStart(today);
            router.refresh();
          }
        });
      }}
    >
      <h2 className="text-sm font-semibold text-ink">{t("Apply for leave")}</h2>

      {result?.status === "error" && !result.fields ? <ErrorNotice error={result.error} /> : null}
      {sent && result?.status === "success" ? (
        <p className="rounded-lg border border-ok/25 bg-ok/5 px-3 py-2 text-sm font-medium text-ok">
          {t("Sent — your manager will approve or reject it.")}
        </p>
      ) : null}

      <div className="inline-flex rounded-xl border border-line bg-surface p-0.5" role="radiogroup">
        {([
          ["full", t("Full day")],
          ["part", t("Part of a day")],
        ] as const).map(([key, label]) => {
          const active = (key === "part") === part;
          return (
            <label key={key}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                active ? "bg-brand text-white" : "text-ink-muted hover:text-ink"}`}>
              <input type="radio" name="partDay" value={key} checked={active}
                onChange={() => setPart(key === "part")} className="sr-only" />
              {label}
            </label>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={part ? t("Date") : t("From")} error={fieldError("startDate")}>
          <input type="date" name="startDate" required min={today} value={start}
            onChange={(e) => setStart(e.target.value)} disabled={pending} className={inputClass} />
        </Field>
        {part ? null : (
          <Field label={t("To")} error={fieldError("endDate")}>
            <input type="date" name="endDate" required min={start} defaultValue={today}
              disabled={pending} className={inputClass} />
          </Field>
        )}
        {part ? (
          <>
            <Field label={t("Start time")} error={fieldError("startTime")}>
              <input type="time" name="startTime" required defaultValue="09:00" disabled={pending} className={inputClass} />
            </Field>
            <Field label={t("End time")} error={fieldError("endTime")}>
              <input type="time" name="endTime" required defaultValue="13:00" disabled={pending} className={inputClass} />
            </Field>
          </>
        ) : null}
      </div>

      <Field label={t("Reason (optional)")} error={fieldError("reason")}>
        <textarea name="reason" rows={2} maxLength={300} disabled={pending}
          placeholder={t("e.g. Family matter")} className={inputClass} />
      </Field>

      <button type="submit" disabled={pending}
        className="w-full cursor-pointer rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white
                   transition hover:bg-brand-700 disabled:opacity-50">
        {pending ? t("Sending…") : t("Send leave request")}
      </button>
    </form>
  );

}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-ink">
        {label}
        <span className="mt-1 block">{children}</span>
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-line bg-card px-3 py-2.5 text-base text-ink " +
  "focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue";
