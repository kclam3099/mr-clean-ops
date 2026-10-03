"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AppointmentDetail, AppointmentCapabilities } from "@/lib/appointments/detail";
import type { BookingConfig } from "@/lib/booking-config/queries";
import {
  updateCustomerAction, updateItemsAction, rescheduleAction,
  cancelAction, completeAction, rescheduleAvailabilityAction, type ActionResult,
} from "@/lib/appointments/lifecycle-actions";
import { AppErrorCode, type AppError } from "@/lib/errors/appError";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { AddonsSection } from "./AddonsSection";
import { OverrideDialog } from "@/components/appointment-form/OverrideDialog";
import { ItemsEditor, initialItemRow, type ItemRow } from "@/components/appointment-form/ItemsEditor";
import { estimatedDurationMinutes, formatDuration, formatMoney, subtotal } from "@/lib/pricing/duration";
import { mapsHref, whatsappHref, whatsappChatHref, buildReminderMessage } from "@/lib/external-links";
import { colourAt, staffInitials } from "@/lib/agenda/staff-colour";
import {
  WhatsAppIcon, PhoneIcon, MapPinIcon, ClockIcon, MoneyIcon, StarIcon,
} from "@/components/ui/icons";
import { useT } from "@/components/i18n/I18nProvider";
import type { Lang, TFunc } from "@/lib/i18n/core";

type Panel = "none" | "customer" | "items" | "reschedule";
/** Which action a pending override retry belongs to. */
type OverrideTarget = "customer" | "items" | "reschedule";

export function AppointmentDetailView({
  detail, capabilities, config, showWorkspace, backHref, invoiceHref,
}: {
  detail: AppointmentDetail;
  capabilities: AppointmentCapabilities;
  config: BookingConfig;
  showWorkspace: boolean;
  backHref: string;
  /** Where "Request invoice" goes — differs between the Master and staff shells. */
  invoiceHref?: string;
}) {
  const router = useRouter();
  const { t, lang } = useT();
  const [panel, setPanel] = useState<Panel>("none");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [override, setOverride] = useState<{ error: AppError; target: OverrideTarget } | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "complete" | null>(null);

  const terminal = detail.status !== "booked";
  /** Server messages stay English in the action; they are translated only for display. */
  const fieldError = (n: string) => {
    const msg = result?.status === "error" ? result.fields?.[n] : undefined;
    return msg === undefined ? undefined : translateFieldError(t, msg);
  };

  /** Runs an action, then either closes the panel or opens the override dialog. */
  function run(
    action: (fd: FormData) => Promise<ActionResult>,
    formData: FormData,
    target: OverrideTarget | null,
  ) {
    if (pending) return;                       // guards against double submit
    startTransition(async () => {
      const res = await action(formData);
      setResult(res);
      if (res.status === "success") {
        setPanel("none");
        setOverride(null);
        setConfirm(null);
        router.refresh();
        return;
      }
      // Only a large-job conflict the caller is allowed to see may be
      // overridden, and only by a Master. STAFF_UNAVAILABLE never opens this:
      // the blocking appointment is hidden from them.
      if (res.error.code === AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED && capabilities.canOverride && target) {
        setOverride({ error: res.error, target });
      } else {
        setOverride(null);
      }
    });
  }

  return (
    <div className="space-y-5 pb-24 lg:pb-6">
      <Header detail={detail} showWorkspace={showWorkspace} backHref={backHref} />

      {result?.status === "error" && !override ? <ErrorNotice error={result.error} /> : null}

      {terminal && detail.status === "completed" && capabilities.canEditCustomer ? (
        <p data-correction-mode className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
          {t("This appointment is completed. As Super Master you can still correct the customer details and services; its time slot stays as it was.")}
        </p>
      ) : terminal ? (
        <p className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
          {t(
            capabilities.canAddAddon
              ? "This appointment is {status}. It is kept as history and can no longer be changed — add-ons can still be recorded below."
              : "This appointment is {status}. It is kept as history and can no longer be changed.",
            { status: statusText(detail.status, lang, t) },
          )}
        </p>
      ) : capabilities.staffLocked ? (
        <p data-staff-locked className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
          {t(capabilities.canComplete
            ? "This appointment is more than 3 days old. You can view it and mark it completed, but it can no longer be edited."
            : "This appointment is more than 3 days old. You can view it, but it can no longer be edited.")}
        </p>
      ) : null}

      <Summary detail={detail} showWorkspace={showWorkspace} />
      <Items detail={detail} />
      <AddonsSection detail={detail} canAdd={capabilities.canAddAddon} />

      {capabilities.canInvoice && invoiceHref ? (
        <a href={invoiceHref} data-request-invoice
          className="flex min-h-12 items-center justify-between gap-3 rounded-xl border-2 border-brand bg-brand/5 px-4 py-3
                     text-sm font-semibold text-brand transition hover:bg-brand/10">
          <span>{detail.invoiceNo ? t("Invoice {no}", { no: detail.invoiceNo }) : t("Request invoice")}</span>
          <span aria-hidden="true">→</span>
        </a>
      ) : null}

      {/* ---------------- actions ---------------- */}
      {!terminal || capabilities.canEditCustomer || capabilities.canEditItems ? (
        <div className="flex flex-wrap gap-2">
          {capabilities.canEditCustomer ? (
            <Action label={t("Edit customer")} active={panel === "customer"}
              onClick={() => { setPanel(panel === "customer" ? "none" : "customer"); setResult(null); }} />
          ) : null}
          {capabilities.canEditItems ? (
            <Action label={t("Edit services")} active={panel === "items"}
              onClick={() => { setPanel(panel === "items" ? "none" : "items"); setResult(null); }} />
          ) : null}
          {capabilities.canReschedule ? (
            <Action label={t("Reschedule")} active={panel === "reschedule"}
              onClick={() => { setPanel(panel === "reschedule" ? "none" : "reschedule"); setResult(null); }} />
          ) : null}
          {capabilities.canComplete ? (
            <Action label={t("Mark completed")} onClick={() => setConfirm("complete")} />
          ) : null}
          {capabilities.canCancel ? (
            <Action label={t("Cancel appointment")} tone="danger" onClick={() => setConfirm("cancel")} />
          ) : null}
        </div>
      ) : null}

      {panel === "customer" ? (
        <CustomerPanel detail={detail} pending={pending} fieldError={fieldError}
          onSubmit={(fd) => run(updateCustomerAction, fd, "customer")} onCancel={() => setPanel("none")} />
      ) : null}

      {panel === "items" ? (
        <ItemsPanel detail={detail} config={config} pending={pending} fieldError={fieldError}
          onSubmit={(fd) => run(updateItemsAction, fd, "items")} onCancel={() => setPanel("none")} />
      ) : null}

      {panel === "reschedule" ? (
        <ReschedulePanel detail={detail} pending={pending} fieldError={fieldError}
          onSubmit={(fd) => run(rescheduleAction, fd, "reschedule")} onCancel={() => setPanel("none")} />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          kind={confirm}
          pending={pending}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            const fd = new FormData();
            fd.set("appointmentId", detail.id);
            if (confirm === "cancel" && reason) fd.set("reason", reason);
            // Neither RPC accepts an override reason, so neither passes a target.
            run(confirm === "cancel" ? cancelAction : completeAction, fd, null);
          }}
        />
      ) : null}

      {override ? (
        <OverrideDialog
          error={override.error}
          pending={pending}
          onCancel={() => { setOverride(null); setResult(null); }}
          onConfirm={(reason) => {
            const form = document.querySelector<HTMLFormElement>(`form[data-panel="${override.target}"]`);
            if (!form) return;
            const fd = new FormData(form);
            fd.set("overrideReason", reason);
            const action = override.target === "customer" ? updateCustomerAction
              : override.target === "items" ? updateItemsAction : rescheduleAction;
            run(action, fd, override.target);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Header({ detail, showWorkspace, backHref }: {
  detail: AppointmentDetail; showWorkspace: boolean; backHref: string;
}) {
  const { t, locale } = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            {detail.customerName}
          </h1>
          <StatusBadge status={detail.status} />
          {detail.isLargeJob ? (
            // Gold as a FILL with navy ink on it, which is how the logo uses
            // it. Gold as text on white is 1.8:1 and unreadable; gold as a
            // ground with dark ink clears 4.5:1 and still shouts.
            <span className="flex items-center gap-1 rounded-full bg-gold px-2.5 py-0.5 text-xs font-bold text-brand-900">
              <StarIcon className="h-3 w-3" />
              {t("Large job")}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink-muted">
          <span className="flex items-center gap-1.5 rounded-lg bg-brand px-2 py-1 font-bold tabular-nums text-white">
            <ClockIcon className="h-3.5 w-3.5 text-gold" />
            {detail.startTime}–{detail.endTime}
          </span>
          <span>{formatDate(detail.date, locale)}</span>
          {detail.staffName ? (
            <span
              className={`flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-xs font-semibold
                          ${colourAt(detail.staffColourIndex).bg} ${colourAt(detail.staffColourIndex).text}`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold
                            text-white ${colourAt(detail.staffColourIndex).solid}`}
              >
                {staffInitials(detail.staffName)}
              </span>
              {detail.staffName}
            </span>
          ) : null}
          {showWorkspace && detail.workspaceName ? (
            <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-ink-muted">
              {detail.workspaceName}
            </span>
          ) : null}
        </div>
      </div>
      <a href={backHref}
        className="shrink-0 cursor-pointer rounded-lg border border-line bg-card px-3 py-2 text-sm
                   font-medium text-ink transition-colors duration-200 hover:bg-sunken">
        {t("Back")}
      </a>
    </div>
  );
}

function Summary({ detail, showWorkspace }: { detail: AppointmentDetail; showWorkspace: boolean }) {
  const maps = mapsHref(detail.addressLine, detail.areaCity);
  const whatsapp = whatsappHref(
    detail.customerPhone,
    buildReminderMessage({
      customerName: detail.customerName, date: detail.date, startTime: detail.startTime,
    }),
  );
  const chat = whatsappChatHref(detail.customerPhone);
  const { t } = useT();
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card">
      {/* Money and time first, on their own band. They are what gets checked
          in the van before knocking, and they were two labels down a list of
          six. */}
      <div className="flex flex-wrap gap-x-6 gap-y-3 border-b-2 border-gold bg-sunken px-4 py-3">
        <div>
          <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            <MoneyIcon className="h-3 w-3" /> {t("Total")}
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-brand">
            {formatMoney(detail.totalAmount)}
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            <ClockIcon className="h-3 w-3" /> {t("Duration")}
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-ink">
            {formatDuration(detail.durationMin, t)}
            <span className="ml-1 text-xs font-normal text-ink-faint">
              {t("+{min}m buffer", { min: detail.bufferMin })}
            </span>
          </p>
        </div>
      </div>

      <dl className="grid gap-3 p-4 sm:grid-cols-2">
        <Row label={t("Phone")} value={detail.customerPhone ?? "—"} />
        <Row label={t("Area")} value={detail.areaCity ?? "—"} />
        <Row label={t("Address")} value={detail.addressLine ?? "—"} wide />
        {showWorkspace ? <Row label={t("Workspace")} value={detail.workspaceName ?? "—"} /> : null}
        {detail.remarks ? <Row label={t("Notes")} value={detail.remarks} wide /> : null}
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-line bg-sunken/50 px-4 py-3">
        {/* Branded on purpose: the glyph and the green say which app opens,
            before the tap. Deep link only — it prefills the reminder and never
            sends it; the user presses send in WhatsApp itself. */}
        {whatsapp ? (
          <a href={whatsapp} target="_blank" rel="noopener noreferrer"
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-[#25D366] px-3.5
                       text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#1da851]">
            <WhatsAppIcon className="h-4 w-4" />
            {t("Reminder")}
          </a>
        ) : null}
        {/* The same app with nothing prefilled: for anything that is not the
            reminder — directions, a question, running late. */}
        {chat ? (
          <a href={chat} target="_blank" rel="noopener noreferrer"
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-[#25D366] px-3.5
                       text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#1da851]">
            <WhatsAppIcon className="h-4 w-4" />
            WhatsApp
          </a>
        ) : null}
        {detail.customerPhone ? (
          <a href={`tel:${detail.customerPhone}`}
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line
                       bg-card px-3.5 text-sm font-semibold text-ink transition-colors duration-200
                       hover:bg-sunken">
            <PhoneIcon className="h-4 w-4 text-ok" />
            {t("Call")}
          </a>
        ) : null}
        {maps ? (
          <a href={maps} target="_blank" rel="noopener noreferrer"
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line
                       bg-card px-3.5 text-sm font-semibold text-ink transition-colors duration-200
                       hover:bg-sunken">
            <MapPinIcon className="h-4 w-4 text-danger" />
            {t("Directions")}
          </a>
        ) : null}
      </div>
    </section>
  );
}

function Items({ detail }: { detail: AppointmentDetail }) {
  const { t } = useT();
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card">
      <h2 className="flex items-center gap-2 bg-brand px-4 py-2.5 text-sm font-semibold text-white">
        <span aria-hidden className="h-4 w-1 rounded-full bg-gold" />
        {t("Services")}
      </h2>
      <ul className="divide-y divide-line">
        {detail.items.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 text-ink">
              {i.description}
              {i.quantity > 1 ? <span className="text-ink-muted"> × {i.quantity}</span> : null}
            </span>
            <span className="shrink-0 tabular-nums font-medium text-ink">{formatMoney(i.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between border-t-2 border-gold bg-sunken px-4 py-3 text-sm font-bold">
        <span className="text-ink">{t("Total")}</span>
        <span className="tabular-nums text-brand">{formatMoney(detail.totalAmount)}</span>
      </div>
    </section>
  );
}

function CustomerPanel({ detail, pending, fieldError, onSubmit, onCancel }: {
  detail: AppointmentDetail; pending: boolean;
  fieldError: (n: string) => string | undefined;
  onSubmit: (fd: FormData) => void; onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <Panel title={t("Edit customer")} onCancel={onCancel}>
      <form data-panel="customer" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
        className="space-y-3">
        <input type="hidden" name="appointmentId" value={detail.id} />
        <Field label={t("Name")} name="customerName" defaultValue={detail.customerName} error={fieldError("customerName")} disabled={pending} />
        <Field label={t("Phone / WhatsApp")} name="customerPhone" defaultValue={detail.customerPhone ?? ""} error={fieldError("customerPhone")} disabled={pending} />
        <Field label={t("Address")} name="addressLine" defaultValue={detail.addressLine ?? ""} error={fieldError("addressLine")} disabled={pending} />
        <Field label={t("Area / city")} name="areaCity" defaultValue={detail.areaCity ?? ""} error={fieldError("areaCity")} disabled={pending} />
        <Field label={t("Notes")} name="remarks" defaultValue={detail.remarks ?? ""} error={fieldError("remarks")} disabled={pending} optional />
        <SaveRow pending={pending} onCancel={onCancel} />
      </form>
    </Panel>
  );
}

function ItemsPanel({ detail, config, pending, fieldError, onSubmit, onCancel }: {
  detail: AppointmentDetail; config: BookingConfig; pending: boolean;
  fieldError: (n: string) => string | undefined;
  onSubmit: (fd: FormData) => void; onCancel: () => void;
}) {
  const [rows, setRows] = useState<ItemRow[]>(() =>
    detail.items.length
      ? detail.items.map((i, index) => ({
          key: `existing-${index}`, description: i.description,
          quantity: String(i.quantity), unitPrice: String(i.unitPrice),
        }))
      : [initialItemRow()]);

  const total = subtotal(rows.map((r) => ({ quantity: Number(r.quantity), unitPrice: Number(r.unitPrice) })));
  const estimate = estimatedDurationMinutes(total, config.rmPerHourRate);
  const { t } = useT();

  return (
    <Panel title={t("Edit services")} onCancel={onCancel}>
      <form data-panel="items" onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.set("appointmentId", detail.id);
        // Reindexed so removing a middle row cannot leave a gap.
        rows.forEach((row, i) => {
          fd.set(`items.${i}.description`, row.description);
          fd.set(`items.${i}.quantity`, row.quantity);
          fd.set(`items.${i}.unitPrice`, row.unitPrice);
        });
        onSubmit(fd);
      }} className="space-y-3">
        <ItemsEditor rows={rows} onChange={setRows}
          errors={(fieldError("items") ? { items: fieldError("items")! } : {})} disabled={pending} />
        <div className="flex justify-between rounded-lg bg-sunken px-3 py-2 text-sm">
          <span className="text-ink-muted">{t("New total")}</span>
          <span className="font-semibold tabular-nums text-ink">{formatMoney(total)}</span>
        </div>
        <p className="text-xs text-ink-muted">
          {t(
            "Estimated duration {duration}. The final duration and whether the new time still fits are confirmed by the system when you save.",
            { duration: formatDuration(estimate, t) },
          )}
        </p>
        <SaveRow pending={pending} onCancel={onCancel} />
      </form>
    </Panel>
  );
}

function ReschedulePanel({ detail, pending, fieldError, onSubmit, onCancel }: {
  detail: AppointmentDetail; pending: boolean;
  fieldError: (n: string) => string | undefined;
  onSubmit: (fd: FormData) => void; onCancel: () => void;
}) {
  const [date, setDate] = useState(detail.date);
  const [time, setTime] = useState(detail.startTime);
  const [slots, setSlots] = useState<{ key: string; times: string[] }>({ key: "", times: [] });

  // Standard-job suggestions only; never amount-aware (migration 0007), so the
  // job's value is deliberately NOT part of this key.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const r = await rescheduleAvailabilityAction({ appointmentId: detail.id, from: date, to: date });
      if (!cancelled) setSlots({ key: date, times: r.slots });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [date, detail.id]);
  const { t } = useT();

  return (
    <Panel title={t("Reschedule")} onCancel={onCancel}>
      <form data-panel="reschedule" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
        className="space-y-3">
        <input type="hidden" name="appointmentId" value={detail.id} />
        <div className="space-y-1">
          <label htmlFor="apptDate" className="block text-sm font-medium text-ink">{t("Date")}</label>
          <input id="apptDate" name="apptDate" type="date" value={date}
            onChange={(e) => setDate(e.target.value)} disabled={pending} className={inputClass} />
          {fieldError("apptDate") ? <p className="text-sm text-red-600">{fieldError("apptDate")}</p> : null}
        </div>

        {slots.key === date && slots.times.length ? (
          <div className="flex flex-wrap gap-2">
            {slots.times.map((slot) => (
              <button key={slot} type="button" onClick={() => setTime(slot)} disabled={pending}
                aria-pressed={time === slot}
                className={`rounded-lg border px-3 py-2 font-mono text-sm tabular-nums transition ${
                  time === slot ? "border-brand bg-brand text-white"
                             : "border-line bg-card text-ink hover:border-brand/50"}`}>
                {slot}
              </button>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-ink-muted">
          {t("Available when checked — final availability is confirmed when saving.")}
        </p>

        <div className="space-y-1">
          <label htmlFor="startTime" className="block text-sm font-medium text-ink">{t("Time")}</label>
          <input id="startTime" name="startTime" type="time" value={time}
            onChange={(e) => setTime(e.target.value)} disabled={pending} className={inputClass} />
          {fieldError("startTime") ? <p className="text-sm text-red-600">{fieldError("startTime")}</p> : null}
        </div>
        <SaveRow pending={pending} onCancel={onCancel} label={t("Reschedule")} />
      </form>
    </Panel>
  );
}

function ConfirmDialog({ kind, pending, onConfirm, onCancel }: {
  kind: "cancel" | "complete"; pending: boolean;
  onConfirm: (reason?: string) => void; onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const { t } = useT();
  const isCancel = kind === "cancel";
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-brand/40 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl">
        <h2 id="confirm-title" className="text-base font-semibold text-ink">
          {isCancel ? t("Cancel this appointment?") : t("Mark this appointment completed?")}
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          {isCancel
            ? t("It becomes history. It cannot be rescheduled, completed or restored afterwards.")
            : t("It becomes history. It cannot be edited, rescheduled or cancelled afterwards.")}
        </p>
        {isCancel ? (
          <>
            <label htmlFor="cancel-reason" className="mt-4 block text-sm font-medium text-ink">
              {t("Reason")} <span className="font-normal text-ink-faint">{t("(optional)")}</span>
            </label>
            <textarea id="cancel-reason" rows={2} value={reason} maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-base
                         focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue" />
          </>
        ) : null}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onCancel} disabled={pending}
            className="flex-1 rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-sunken">
            {t("Keep it")}
          </button>
          <button type="button" disabled={pending}
            onClick={() => onConfirm(isCancel ? reason.trim() || undefined : undefined)}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50 ${
              isCancel ? "bg-red-600 hover:bg-red-700" : "bg-brand hover:bg-brand-700"}`}>
            {pending ? t("Working…") : isCancel ? t("Cancel appointment") : t("Mark completed")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ atoms */

const inputClass =
  "w-full rounded-lg border border-line px-3 py-2.5 text-base text-ink " +
  "focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue";

function Panel({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  const { t } = useT();
  return (
    <section className="rounded-xl border border-line bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <button type="button" onClick={onCancel} className="text-sm text-ink-muted hover:text-ink">{t("Close")}</button>
      </div>
      {children}
    </section>
  );
}

function Field({ label, name, defaultValue, error, disabled, optional }: {
  label: string; name: string; defaultValue: string; error?: string; disabled: boolean; optional?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="space-y-1">
      <label htmlFor={name} className="block text-sm font-medium text-ink">
        {label}{optional ? <span className="ml-1 font-normal text-ink-faint">{t("(optional)")}</span> : null}
      </label>
      <input id={name} name={name} defaultValue={defaultValue} disabled={disabled} className={inputClass} />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function SaveRow({ pending, onCancel, label }: {
  pending: boolean; onCancel: () => void; label?: string;
}) {
  const { t } = useT();
  return (
    <div className="flex gap-2 pt-1">
      <button type="button" onClick={onCancel} disabled={pending}
        className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-sunken">
        {t("Cancel")}
      </button>
      <button type="submit" disabled={pending}
        className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50">
        {pending ? t("Saving…") : (label ?? t("Save changes"))}
      </button>
    </div>
  );
}

function Action({ label, onClick, active, tone }: {
  label: string; onClick: () => void; active?: boolean; tone?: "danger";
}) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
        active ? "border-brand bg-brand text-white"
        : tone === "danger" ? "border-red-300 bg-card text-red-700 hover:bg-red-50"
        : "border-line bg-card text-ink hover:bg-sunken"}`}>
      {label}
    </button>
  );
}

function Row({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: AppointmentDetail["status"] }) {
  const { t, lang } = useT();
  const styles = {
    booked: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-sunken text-ink-muted",
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}>
      {statusText(status, lang, t)}
    </span>
  );
}

/**
 * The status word as shown. English renders the raw value exactly as before
 * (capitalised by CSS in the badge); Chinese uses the dictionary label.
 */
const STATUS_LABEL: Record<AppointmentDetail["status"], string> = {
  booked: "Booked",
  completed: "Completed",
  cancelled: "Cancelled",
};

function statusText(status: AppointmentDetail["status"], lang: Lang, t: TFunc): string {
  return lang === "zh" ? t(STATUS_LABEL[status]) : status;
}

/** Field errors arrive in English from the server action; translated for display only. */
function translateFieldError(t: TFunc, msg: string): string {
  const max = /^Keep this under (\d+) characters$/.exec(msg);
  return max ? t("Keep this under {max} characters", { max: max[1] as string }) : t(msg);
}

function formatDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}
