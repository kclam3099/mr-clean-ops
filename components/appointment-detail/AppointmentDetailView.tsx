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
import { OverrideDialog } from "@/components/appointment-form/OverrideDialog";
import { ItemsEditor, initialItemRow, type ItemRow } from "@/components/appointment-form/ItemsEditor";
import { estimatedDurationMinutes, formatDuration, formatMoney, subtotal } from "@/lib/pricing/duration";
import { mapsHref, whatsappHref, buildReminderMessage } from "@/lib/external-links";

type Panel = "none" | "customer" | "items" | "reschedule";
/** Which action a pending override retry belongs to. */
type OverrideTarget = "customer" | "items" | "reschedule";

export function AppointmentDetailView({
  detail, capabilities, config, showWorkspace, backHref,
}: {
  detail: AppointmentDetail;
  capabilities: AppointmentCapabilities;
  config: BookingConfig;
  showWorkspace: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [override, setOverride] = useState<{ error: AppError; target: OverrideTarget } | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "complete" | null>(null);

  const terminal = detail.status !== "booked";
  const fieldError = (n: string) => (result?.status === "error" ? result.fields?.[n] : undefined);

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

      {terminal ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          This appointment is {detail.status}. It is kept as history and can no longer be changed.
        </p>
      ) : null}

      <Summary detail={detail} showWorkspace={showWorkspace} />
      <Items detail={detail} />

      {/* ---------------- actions ---------------- */}
      {!terminal ? (
        <div className="flex flex-wrap gap-2">
          {capabilities.canEditCustomer ? (
            <Action label="Edit customer" active={panel === "customer"}
              onClick={() => { setPanel(panel === "customer" ? "none" : "customer"); setResult(null); }} />
          ) : null}
          {capabilities.canEditItems ? (
            <Action label="Edit services" active={panel === "items"}
              onClick={() => { setPanel(panel === "items" ? "none" : "items"); setResult(null); }} />
          ) : null}
          {capabilities.canReschedule ? (
            <Action label="Reschedule" active={panel === "reschedule"}
              onClick={() => { setPanel(panel === "reschedule" ? "none" : "reschedule"); setResult(null); }} />
          ) : null}
          {capabilities.canComplete ? (
            <Action label="Mark completed" onClick={() => setConfirm("complete")} />
          ) : null}
          {capabilities.canCancel ? (
            <Action label="Cancel appointment" tone="danger" onClick={() => setConfirm("cancel")} />
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
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            {detail.customerName}
          </h1>
          <StatusBadge status={detail.status} />
          {detail.isLargeJob ? (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
              Large job
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {formatDate(detail.date)} · <span className="font-mono tabular-nums">{detail.startTime}–{detail.endTime}</span>
          {detail.staffName ? ` · ${detail.staffName}` : ""}
          {showWorkspace && detail.workspaceName ? ` · ${detail.workspaceName}` : ""}
        </p>
      </div>
      <a href={backHref}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50">
        Back
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
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Row label="Phone" value={detail.customerPhone ?? "—"} />
        <Row label="Area" value={detail.areaCity ?? "—"} />
        <Row label="Address" value={detail.addressLine ?? "—"} wide />
        <Row label="Total" value={formatMoney(detail.totalAmount)} />
        <Row label="Duration" value={`${formatDuration(detail.durationMin)} (+${detail.bufferMin} min buffer)`} />
        {showWorkspace ? <Row label="Workspace" value={detail.workspaceName ?? "—"} /> : null}
        {detail.remarks ? <Row label="Notes" value={detail.remarks} wide /> : null}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        {maps ? (
          <a href={maps} target="_blank" rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50">
            Directions
          </a>
        ) : null}
        {detail.customerPhone ? (
          <a href={`tel:${detail.customerPhone}`}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50">
            Call
          </a>
        ) : null}
        {/* Opens WhatsApp with the reminder prefilled. Nothing is sent without
            the user pressing send in WhatsApp itself. */}
        {whatsapp ? (
          <a href={whatsapp} target="_blank" rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50">
            WhatsApp reminder
          </a>
        ) : null}
      </div>
    </section>
  );
}

function Items({ detail }: { detail: AppointmentDetail }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700">Services</h2>
      <ul className="divide-y divide-slate-100">
        {detail.items.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 text-slate-800">
              {i.description}
              {i.quantity > 1 ? <span className="text-slate-500"> × {i.quantity}</span> : null}
            </span>
            <span className="shrink-0 tabular-nums text-slate-700">{formatMoney(i.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between border-t border-slate-200 px-4 py-2.5 text-sm font-semibold">
        <span className="text-slate-700">Total</span>
        <span className="tabular-nums text-slate-900">{formatMoney(detail.totalAmount)}</span>
      </div>
    </section>
  );
}

function CustomerPanel({ detail, pending, fieldError, onSubmit, onCancel }: {
  detail: AppointmentDetail; pending: boolean;
  fieldError: (n: string) => string | undefined;
  onSubmit: (fd: FormData) => void; onCancel: () => void;
}) {
  return (
    <Panel title="Edit customer" onCancel={onCancel}>
      <form data-panel="customer" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
        className="space-y-3">
        <input type="hidden" name="appointmentId" value={detail.id} />
        <Field label="Name" name="customerName" defaultValue={detail.customerName} error={fieldError("customerName")} disabled={pending} />
        <Field label="Phone / WhatsApp" name="customerPhone" defaultValue={detail.customerPhone ?? ""} error={fieldError("customerPhone")} disabled={pending} />
        <Field label="Address" name="addressLine" defaultValue={detail.addressLine ?? ""} error={fieldError("addressLine")} disabled={pending} />
        <Field label="Area / city" name="areaCity" defaultValue={detail.areaCity ?? ""} error={fieldError("areaCity")} disabled={pending} />
        <Field label="Notes" name="remarks" defaultValue={detail.remarks ?? ""} error={fieldError("remarks")} disabled={pending} optional />
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

  return (
    <Panel title="Edit services" onCancel={onCancel}>
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
        <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-600">New total</span>
          <span className="font-semibold tabular-nums text-slate-900">{formatMoney(total)}</span>
        </div>
        <p className="text-xs text-slate-500">
          Estimated duration {formatDuration(estimate)}. The final duration and whether the new
          time still fits are confirmed by the system when you save.
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

  return (
    <Panel title="Reschedule" onCancel={onCancel}>
      <form data-panel="reschedule" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
        className="space-y-3">
        <input type="hidden" name="appointmentId" value={detail.id} />
        <div className="space-y-1">
          <label htmlFor="apptDate" className="block text-sm font-medium text-slate-700">Date</label>
          <input id="apptDate" name="apptDate" type="date" value={date}
            onChange={(e) => setDate(e.target.value)} disabled={pending} className={inputClass} />
          {fieldError("apptDate") ? <p className="text-sm text-red-600">{fieldError("apptDate")}</p> : null}
        </div>

        {slots.key === date && slots.times.length ? (
          <div className="flex flex-wrap gap-2">
            {slots.times.map((t) => (
              <button key={t} type="button" onClick={() => setTime(t)} disabled={pending}
                aria-pressed={time === t}
                className={`rounded-lg border px-3 py-2 font-mono text-sm tabular-nums transition ${
                  time === t ? "border-slate-900 bg-slate-900 text-white"
                             : "border-slate-300 bg-white text-slate-800 hover:border-slate-400"}`}>
                {t}
              </button>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-slate-500">
          Available when checked — final availability is confirmed when saving.
        </p>

        <div className="space-y-1">
          <label htmlFor="startTime" className="block text-sm font-medium text-slate-700">Time</label>
          <input id="startTime" name="startTime" type="time" value={time}
            onChange={(e) => setTime(e.target.value)} disabled={pending} className={inputClass} />
          {fieldError("startTime") ? <p className="text-sm text-red-600">{fieldError("startTime")}</p> : null}
        </div>
        <SaveRow pending={pending} onCancel={onCancel} label="Reschedule" />
      </form>
    </Panel>
  );
}

function ConfirmDialog({ kind, pending, onConfirm, onCancel }: {
  kind: "cancel" | "complete"; pending: boolean;
  onConfirm: (reason?: string) => void; onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const isCancel = kind === "cancel";
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 id="confirm-title" className="text-base font-semibold text-slate-900">
          {isCancel ? "Cancel this appointment?" : "Mark this appointment completed?"}
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          {isCancel
            ? "It becomes history. It cannot be rescheduled, completed or restored afterwards."
            : "It becomes history. It cannot be edited, rescheduled or cancelled afterwards."}
        </p>
        {isCancel ? (
          <>
            <label htmlFor="cancel-reason" className="mt-4 block text-sm font-medium text-slate-700">
              Reason <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <textarea id="cancel-reason" rows={2} value={reason} maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base
                         focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900" />
          </>
        ) : null}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onCancel} disabled={pending}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
            Keep it
          </button>
          <button type="button" disabled={pending}
            onClick={() => onConfirm(isCancel ? reason.trim() || undefined : undefined)}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50 ${
              isCancel ? "bg-red-600 hover:bg-red-700" : "bg-slate-900 hover:bg-slate-800"}`}>
            {pending ? "Working…" : isCancel ? "Cancel appointment" : "Mark completed"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ atoms */

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 " +
  "focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900";

function Panel({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  return (
    <section className="rounded-xl border border-slate-300 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-900">Close</button>
      </div>
      {children}
    </section>
  );
}

function Field({ label, name, defaultValue, error, disabled, optional }: {
  label: string; name: string; defaultValue: string; error?: string; disabled: boolean; optional?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={name} className="block text-sm font-medium text-slate-700">
        {label}{optional ? <span className="ml-1 font-normal text-slate-400">(optional)</span> : null}
      </label>
      <input id={name} name={name} defaultValue={defaultValue} disabled={disabled} className={inputClass} />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function SaveRow({ pending, onCancel, label = "Save changes" }: {
  pending: boolean; onCancel: () => void; label?: string;
}) {
  return (
    <div className="flex gap-2 pt-1">
      <button type="button" onClick={onCancel} disabled={pending}
        className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
        Cancel
      </button>
      <button type="submit" disabled={pending}
        className="flex-1 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50">
        {pending ? "Saving…" : label}
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
        active ? "border-slate-900 bg-slate-900 text-white"
        : tone === "danger" ? "border-red-300 bg-white text-red-700 hover:bg-red-50"
        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
      {label}
    </button>
  );
}

function Row({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: AppointmentDetail["status"] }) {
  const styles = {
    booked: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-slate-200 text-slate-700",
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}>
      {status}
    </span>
  );
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}
