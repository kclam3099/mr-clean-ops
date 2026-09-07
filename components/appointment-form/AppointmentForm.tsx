"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BookingContext } from "@/lib/appointments/context";
import type { BookingConfig } from "@/lib/booking-config/queries";
import { createAppointmentAction, findAvailabilityAction, type CreateResult } from "@/lib/appointments/actions";
import { AppErrorCode, type AppError } from "@/lib/errors/appError";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { estimatedDurationMinutes, formatDuration, formatMoney, subtotal } from "@/lib/pricing/duration";
import { ItemsEditor, initialItemRow, type ItemRow } from "./ItemsEditor";
import { AvailabilitySuggestions } from "./AvailabilitySuggestions";
import { OverrideDialog } from "./OverrideDialog";

/**
 * One form for both roles. `context.mode` decides what renders; the server
 * decides what is permitted. Nothing here is a security control.
 */
export function AppointmentForm({
  context,
  config,
  returnTo,
  initialDate,
  initialTime,
  businessToday,
}: {
  context: BookingContext;
  config: BookingConfig;
  returnTo?: string;
  initialDate?: string;
  initialTime?: string;
  businessToday: string;
}) {
  const router = useRouter();
  const isMaster = context.mode === "master";
  const formRef = useRef<HTMLFormElement>(null);

  const [workspaceId, setWorkspaceId] = useState(context.preselectedWorkspaceId ?? "");
  const [staffId, setStaffId] = useState(context.preselectedStaffId ?? "");
  const [apptDate, setApptDate] = useState(initialDate ?? "");
  const [startTime, setStartTime] = useState(initialTime ?? "");
  const [items, setItems] = useState<ItemRow[]>(() => [initialItemRow()]);

  const [result, setResult] = useState<CreateResult | null>(null);
  const [overrideFor, setOverrideFor] = useState<AppError | null>(null);
  const [pending, startTransition] = useTransition();

  // Keyed by the inputs that produced it, so a stale result for a previous
  // date can never be shown as if it were current.
  const [availability, setAvailability] = useState<{ key: string; slots: string[] }>({
    key: "", slots: [],
  });

  const workspace = context.workspaces.find((w) => w.id === workspaceId) ?? null;
  const staffOptions = workspace?.staff ?? [];

  // Changing workspace invalidates a staff choice that does not belong to it.
  // Handled in the event, not an effect — it is a consequence of the user's
  // action, not a synchronisation with an external system.
  function changeWorkspace(next: string) {
    setWorkspaceId(next);
    const options = context.workspaces.find((w) => w.id === next)?.staff ?? [];
    if (staffId && !options.some((s) => s.id === staffId)) setStaffId("");
  }

  const total = useMemo(
    () => subtotal(items.map((i) => ({ quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) }))),
    [items],
  );
  const estimate = estimatedDurationMinutes(total, config.rmPerHourRate);

  // Effective staff for availability: Masters pick, staff are themselves.
  const effectiveStaffId = isMaster ? staffId : context.selfStaffId ?? "";

  // ---------------------------------------------------------------------
  // Availability. Depends on workspace, staff and date ONLY.
  //
  // `total` is deliberately NOT a dependency. Availability is standard-job
  // only (migration 0007): re-running it when the amount changes is precisely
  // the oracle that let a Shared-only Master binary-search a hidden
  // appointment's start time. Do not add `total` here.
  // ---------------------------------------------------------------------
  const queryKey =
    workspaceId && effectiveStaffId && apptDate
      ? `${workspaceId}|${effectiveStaffId}|${apptDate}`
      : "";

  useEffect(() => {
    if (!queryKey) return;
    const [ws, staff, date] = queryKey.split("|") as [string, string, string];
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await findAvailabilityAction({ workspaceId: ws, staffId: staff, from: date, to: date });
      if (cancelled) return;
      setAvailability({ key: queryKey, slots: res.status === "ok" ? res.slots.map((s) => s.time) : [] });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [queryKey]);

  const isFresh = availability.key === queryKey;
  const slots = isFresh ? availability.slots : [];
  const slotsLoading = queryKey !== "" && !isFresh;

  const fieldError = (name: string) =>
    result?.status === "error" ? result.fields?.[name] : undefined;

  function buildFormData(overrideReason?: string): FormData {
    const fd = new FormData();
    fd.set("workspaceId", workspaceId);
    if (isMaster && staffId) fd.set("staffId", staffId);
    for (const key of ["customerName", "customerPhone", "addressLine", "areaCity", "remarks"]) {
      const el = formRef.current?.elements.namedItem(key) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el?.value) fd.set(key, el.value);
    }
    fd.set("apptDate", apptDate);
    fd.set("startTime", startTime);
    // Reindexed here so removing a middle row cannot leave a gap.
    items.forEach((row, i) => {
      fd.set(`items.${i}.description`, row.description);
      fd.set(`items.${i}.quantity`, row.quantity);
      fd.set(`items.${i}.unitPrice`, row.unitPrice);
    });
    if (returnTo) fd.set("returnTo", returnTo);
    if (overrideReason) fd.set("overrideReason", overrideReason);
    return fd;
  }

  function submit(overrideReason?: string) {
    if (pending) return;                     // guards against double submit
    startTransition(async () => {
      const res = await createAppointmentAction(null, buildFormData(overrideReason));
      setResult(res);

      if (res.status === "success") {
        setOverrideFor(null);
        router.push(res.redirectTo);
        router.refresh();
        return;
      }

      // ONLY this code opens the override dialog, and only for a Master.
      // STAFF_UNAVAILABLE deliberately does not: the blocking appointment is
      // hidden from this caller, so there is nothing they may override.
      if (res.error.code === AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED && isMaster) {
        setOverrideFor(res.error);
      } else {
        setOverrideFor(null);
      }
    });
  }

  const canSubmit =
    !pending && workspaceId !== "" && (!isMaster || staffId !== "") && apptDate !== "" && startTime !== "";

  return (
    <>
      <form
        ref={formRef}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]"
      >
        <div className="min-w-0 space-y-6">
          {/* ---------------- A. Booking context ---------------- */}
          <Section title="Booking context">
            {isMaster ? (
              context.needsWorkspaceChoice ? (
                <Field label="Workspace" htmlFor="workspaceId" error={fieldError("workspaceId")}>
                  <select
                    id="workspaceId"
                    value={workspaceId}
                    onChange={(e) => changeWorkspace(e.target.value)}
                    disabled={pending}
                    className={selectClass}
                  >
                    <option value="">Choose a workspace…</option>
                    {context.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </Field>
              ) : (
                // Exactly one workspace: a label, never a one-option selector.
                // A selector would imply there are others.
                <p className="text-sm text-slate-600">
                  Workspace: <span className="font-medium text-slate-900">{workspace?.name}</span>
                </p>
              )
            ) : (
              <StaffContext context={context} workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} pending={pending} />
            )}

            {isMaster ? (
              <Field label="Team member" htmlFor="staffId" error={fieldError("staffId")}>
                <select
                  id="staffId"
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                  disabled={pending || !workspaceId}
                  className={selectClass}
                >
                  <option value="">{workspaceId ? "Choose a team member…" : "Choose a workspace first"}</option>
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
          </Section>

          {/* ---------------- B. Customer ---------------- */}
          <Section title="Customer">
            <Field label="Name" htmlFor="customerName" error={fieldError("customerName")}>
              <input id="customerName" name="customerName" disabled={pending} className={inputClass} />
            </Field>
            <Field label="Phone / WhatsApp" htmlFor="customerPhone" error={fieldError("customerPhone")}>
              <input id="customerPhone" name="customerPhone" type="tel" inputMode="tel" disabled={pending} className={inputClass} />
            </Field>
            <Field label="Address" htmlFor="addressLine" error={fieldError("addressLine")}>
              <input id="addressLine" name="addressLine" disabled={pending} className={inputClass} />
            </Field>
            <Field label="Area / city" htmlFor="areaCity" error={fieldError("areaCity")}>
              <input id="areaCity" name="areaCity" disabled={pending} className={inputClass} />
            </Field>
            <Field label="Notes" htmlFor="remarks" error={fieldError("remarks")} optional>
              <textarea id="remarks" name="remarks" rows={2} disabled={pending} className={inputClass} />
            </Field>
          </Section>

          {/* ---------------- C. Job items ---------------- */}
          <Section title="Services">
            <ItemsEditor
              rows={items}
              onChange={setItems}
              errors={(result?.status === "error" ? result.fields : undefined) ?? {}}
              disabled={pending}
            />
          </Section>

          {/* ---------------- D. Date & time ---------------- */}
          <Section title="Date & time">
            <QuickDates value={apptDate} onPick={setApptDate} businessToday={businessToday} disabled={pending} />
            <Field label="Date" htmlFor="apptDate" error={fieldError("apptDate")}>
              <input
                id="apptDate" type="date" value={apptDate}
                min={businessToday}
                onChange={(e) => setApptDate(e.target.value)}
                disabled={pending} className={inputClass}
              />
            </Field>

            <AvailabilitySuggestions
              slots={slots} loading={slotsLoading} selectedTime={startTime}
              onPick={setStartTime} disabled={pending}
            />

            <Field label="Time" htmlFor="startTime" error={fieldError("startTime")}>
              <input
                id="startTime" type="time" value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={pending} className={inputClass}
              />
            </Field>
          </Section>
        </div>

        {/* ---------------- E. Review & save ---------------- */}
        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Summary</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Total" value={formatMoney(total)} strong />
              <Row label="Estimated duration" value={formatDuration(estimate)} />
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              Estimated only. The final duration and availability are confirmed by the
              system when you save.
            </p>

            {result?.status === "error" && !overrideFor ? (
              <div className="mt-4">
                <ErrorNotice error={result.error} />
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-4 w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white
                         transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save appointment"}
            </button>
          </div>
        </aside>
      </form>

      {overrideFor ? (
        <OverrideDialog
          error={overrideFor}
          pending={pending}
          onCancel={() => { setOverrideFor(null); setResult(null); }}
          onConfirm={(reason) => submit(reason)}
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- helpers */

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 " +
  "placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900";
const selectClass = inputClass + " bg-white";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label, htmlFor, error, optional, children,
}: {
  label: string; htmlFor: string; error?: string; optional?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
        {optional ? <span className="ml-1 font-normal text-slate-400">(optional)</span> : null}
      </label>
      {children}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold text-slate-900" : "text-slate-700"}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Staff booking context. There is never a staff selector — identity comes from
 * the session, and the RPC derives it from the JWT regardless of what is
 * submitted. A workspace selector appears only when the person genuinely
 * belongs to more than one.
 */
function StaffContext({
  context, workspaceId, setWorkspaceId, pending,
}: {
  context: BookingContext; workspaceId: string;
  setWorkspaceId: (v: string) => void; pending: boolean;
}) {
  return (
    <>
      <p className="text-sm text-slate-600">
        Booking for <span className="font-medium text-slate-900">{context.selfStaffName ?? "you"}</span>
      </p>
      {context.needsWorkspaceChoice ? (
        <Field label="Workspace" htmlFor="workspaceId">
          <select
            id="workspaceId" value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={pending} className={selectClass}
          >
            <option value="">Choose a workspace…</option>
            {context.workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </Field>
      ) : null}
    </>
  );
}

function QuickDates({
  value, onPick, businessToday, disabled,
}: {
  value: string; onPick: (d: string) => void; businessToday: string; disabled: boolean;
}) {
  const add = (days: number) => {
    const [y, m, d] = businessToday.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  };
  const options = [
    ["Today", add(0)],
    ["Tomorrow", add(1)],
    ["In 2 days", add(2)],
    ["Next week", add(7)],
  ] as const;

  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([label, date]) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(date)}
          disabled={disabled}
          aria-pressed={value === date}
          className={`rounded-lg border px-3 py-2 text-sm transition ${
            value === date
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
