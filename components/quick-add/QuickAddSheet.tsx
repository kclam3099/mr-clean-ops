"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getQuickAddContextAction,
  quickAddCreateAction,
  type QuickAddContext,
  type QuickAddStaffOption,
} from "@/lib/appointments/quick-add-actions";
import { ItemsEditor, initialItemRow, type ItemRow } from "@/components/appointment-form/ItemsEditor";
import { OverrideDialog } from "@/components/appointment-form/OverrideDialog";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { AppErrorCode, type AppError } from "@/lib/errors/appError";
import { subtotal, formatMoney } from "@/lib/pricing/duration";

/**
 * Quick Add — details first, staff last.
 *
 * The flow inverts the old one deliberately: the owner types what the customer
 * said, and only then decides who takes it. Workspace is never asked on the
 * normal path; the server derives it from the staff member chosen at the end.
 *
 * Two rules this component exists to keep:
 *
 *   - Tapping a staff card means ASSIGN + CREATE. There is no second Save, and
 *     no availability pre-check — `find_available_slots` is standard-job only,
 *     so a pre-check could disagree with the real appointment's duration, and
 *     making it amount-aware would reintroduce the oracle closed in 0007. The
 *     database decides.
 *
 *   - A refused booking never costs the typing. Everything entered lives here
 *     and is re-sent on each attempt; only the staff choice is retried.
 */

type Step = "details" | "assign" | "workspace";

type Details = {
  customerName: string;
  customerPhone: string;
  addressLine: string;
  areaCity: string;
  apptDate: string;
  startTime: string;
  remarks: string;
  items: ItemRow[];
};

const emptyDetails = (): Details => ({
  customerName: "",
  customerPhone: "",
  addressLine: "",
  areaCity: "",
  apptDate: "",
  startTime: "",
  remarks: "",
  items: [initialItemRow()],
});

export function QuickAddSheet({
  businessToday,
  onClose,
  onSuccess,
}: {
  businessToday: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const router = useRouter();
  const [context, setContext] = useState<QuickAddContext | null>(null);
  const [step, setStep] = useState<Step>("details");
  const [details, setDetails] = useState<Details>(emptyDetails);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);
  const [chosenStaff, setChosenStaff] = useState<QuickAddStaffOption | null>(null);
  const [workspaceOptions, setWorkspaceOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [overrideFor, setOverrideFor] = useState<AppError | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  // The assignment list is fetched HERE, on open — not embedded in the page.
  // No staff array reaches the RSC payload of /calendar, /dashboard or any
  // other surface, so there is nothing to hide client-side.
  useEffect(() => {
    let cancelled = false;
    getQuickAddContextAction().then((c) => {
      if (!cancelled) setContext(c);
    });
    return () => { cancelled = true; };
  }, []);

  // Focus management: trap inside the panel, restore to whatever opened it.
  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.querySelector<HTMLElement>("input, button")?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) { onClose(); return; }
      if (e.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose, pending]);

  const isStaffMode = context?.mode === "staff";
  const total = subtotal(
    details.items.map((i) => ({ quantity: Number(i.quantity) || 0, unitPrice: Number(i.unitPrice) || 0 })),
  );

  /** Cheap local completeness check, so the assign step is not reached with an
   *  obviously empty form. The server still validates — this is not a control. */
  function missingField(): string | null {
    if (!details.customerName.trim()) return "customerName";
    if (!details.customerPhone.trim()) return "customerPhone";
    if (!details.addressLine.trim()) return "addressLine";
    if (!details.areaCity.trim()) return "areaCity";
    if (!details.apptDate) return "apptDate";
    if (!details.startTime) return "startTime";
    if (!details.items.some((i) => i.description.trim() && i.unitPrice !== "")) return "items";
    return null;
  }

  function payload(staffId: string | null, workspaceId?: string, overrideReason?: string) {
    return {
      staffId,
      ...(workspaceId ? { workspaceId } : {}),
      customerName: details.customerName,
      customerPhone: details.customerPhone,
      addressLine: details.addressLine,
      areaCity: details.areaCity,
      apptDate: details.apptDate,
      startTime: details.startTime,
      remarks: details.remarks,
      items: details.items
        .filter((i) => i.description.trim() !== "" || i.unitPrice !== "")
        .map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })),
      ...(overrideReason ? { overrideReason } : {}),
    };
  }

  async function submit(staff: QuickAddStaffOption | null, workspaceId?: string, overrideReason?: string) {
    setPending(true);
    setError(null);
    setFields({});
    const result = await quickAddCreateAction(payload(staff?.id ?? null, workspaceId, overrideReason));
    setPending(false);

    if (result.status === "success") {
      onSuccess(`Assigned to ${result.staffName}`);
      // Server components re-render in place; nothing optimistic was drawn.
      router.refresh();
      onClose();
      return;
    }

    if (result.status === "needsWorkspace") {
      setWorkspaceOptions(result.workspaces);
      setStep("workspace");
      return;
    }

    // A malformed booking is the form's problem — go back and show it.
    if (result.error.code === AppErrorCode.VALIDATION_ERROR) {
      setFields(result.fields ?? {});
      setError(result.error);
      setStep("details");
      return;
    }

    // Masters only, and only from a visible large-job conflict. Never from
    // STAFF_UNAVAILABLE — that conflict is hidden from this caller, so offering
    // to override it would disclose that it exists.
    if (result.error.code === AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED && !isStaffMode) {
      setOverrideFor(result.error);
      return;
    }

    // Everything else — unavailable, overlap, working hours, time off, past —
    // returns to the choice with the typing intact.
    setError(result.error);
    setStep(isStaffMode ? "details" : "assign");
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-slate-900/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !pending) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-title"
        className="flex h-full w-full flex-col bg-white shadow-xl sm:max-w-lg"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 id="quick-add-title" className="text-base font-semibold text-slate-900">
            {step === "details" ? "New appointment"
              : step === "assign" ? "Assign to"
              : "Which team?"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            className="rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {context === null ? (
            <p className="text-sm text-slate-500" aria-busy="true">Loading…</p>
          ) : context.mode === "unavailable" ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              There is no workspace with active team members available to you.
            </p>
          ) : (
            <>
              {error ? <div className="mb-4"><ErrorNotice error={error} /></div> : null}

              {step === "details" ? (
                <DetailsStep
                  details={details}
                  setDetails={setDetails}
                  fields={fields}
                  disabled={pending}
                  businessToday={businessToday}
                />
              ) : null}

              {step === "assign" && context.mode === "master" ? (
                <AssignStep
                  summary={<Summary details={details} total={total} onEdit={() => setStep("details")} />}
                  staff={context.staff}
                  disabled={pending}
                  pendingFor={pending ? chosenStaff?.id ?? null : null}
                  onPick={(s) => { setChosenStaff(s); void submit(s); }}
                />
              ) : null}

              {step === "workspace" ? (
                <WorkspaceStep
                  options={workspaceOptions}
                  disabled={pending}
                  onPick={(id) => void submit(chosenStaff, id)}
                />
              ) : null}
            </>
          )}
        </div>

        {context && context.mode !== "unavailable" && step === "details" ? (
          <footer className="sticky bottom-0 border-t border-slate-200 bg-white px-4 py-3">
            <p className="mb-2 text-sm text-slate-500">
              Estimated total <span className="font-medium text-slate-800">{formatMoney(total)}</span>
            </p>
            <button
              type="button"
              disabled={pending || missingField() !== null}
              onClick={() => {
                if (isStaffMode) { void submit(null); return; }
                setError(null);
                setStep("assign");
              }}
              className="w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-medium text-white
                         transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStaffMode ? (pending ? "Saving…" : "Save appointment") : "Assign staff →"}
            </button>
          </footer>
        ) : null}
      </div>

      {overrideFor ? (
        <OverrideDialog
          error={overrideFor}
          pending={pending}
          onCancel={() => { setOverrideFor(null); setStep("assign"); }}
          onConfirm={(reason) => {
            setOverrideFor(null);
            void submit(chosenStaff, undefined, reason);
          }}
        />
      ) : null}
    </div>
  );
}

function Summary({ details, total, onEdit }: { details: Details; total: number; onEdit: () => void }) {
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-900">{details.customerName}</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {details.apptDate} · {details.startTime} · {formatMoney(total)}
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function DetailsStep({
  details, setDetails, fields, disabled, businessToday,
}: {
  details: Details;
  setDetails: (d: Details) => void;
  fields: Record<string, string>;
  disabled: boolean;
  businessToday: string;
}) {
  const set = (patch: Partial<Details>) => setDetails({ ...details, ...patch });
  const input =
    "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 " +
    "placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900";

  return (
    <div className="space-y-4">
      <Field label="Customer name" htmlFor="qa-name" error={fields.customerName}>
        <input id="qa-name" name="customerName" className={input} disabled={disabled}
          value={details.customerName} onChange={(e) => set({ customerName: e.target.value })} />
      </Field>
      <Field label="Phone / WhatsApp" htmlFor="qa-phone" error={fields.customerPhone}>
        <input id="qa-phone" name="customerPhone" type="tel" inputMode="tel" className={input} disabled={disabled}
          value={details.customerPhone} onChange={(e) => set({ customerPhone: e.target.value })} />
      </Field>
      <Field label="Address" htmlFor="qa-address" error={fields.addressLine}>
        <input id="qa-address" name="addressLine" className={input} disabled={disabled}
          value={details.addressLine} onChange={(e) => set({ addressLine: e.target.value })} />
      </Field>
      <Field label="Area / city" htmlFor="qa-area" error={fields.areaCity}>
        <input id="qa-area" name="areaCity" className={input} disabled={disabled}
          value={details.areaCity} onChange={(e) => set({ areaCity: e.target.value })} />
      </Field>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Services</p>
        <ItemsEditor
          rows={details.items}
          onChange={(items) => set({ items })}
          errors={fields}
          disabled={disabled}
        />
      </div>

      <div className="flex gap-3">
        <Field label="Date" htmlFor="qa-date" error={fields.apptDate}>
          <input id="qa-date" name="apptDate" type="date" min={businessToday} className={input} disabled={disabled}
            value={details.apptDate} onChange={(e) => set({ apptDate: e.target.value })} />
        </Field>
        <Field label="Time" htmlFor="qa-time" error={fields.startTime}>
          <input id="qa-time" name="startTime" type="time" className={input} disabled={disabled}
            value={details.startTime} onChange={(e) => set({ startTime: e.target.value })} />
        </Field>
      </div>

      <Field label="Remarks (optional)" htmlFor="qa-remarks" error={fields.remarks}>
        <textarea id="qa-remarks" name="remarks" rows={2} className={input} disabled={disabled}
          value={details.remarks} onChange={(e) => set({ remarks: e.target.value })} />
      </Field>
    </div>
  );
}

/**
 * The assignment step.
 *
 * `staff` arrives already limited to what this caller may see. There is no
 * disabled entry, no count and no "hidden" placeholder — a Partner Master
 * simply receives a shorter list, with no way to tell it is shorter.
 */
function AssignStep({
  summary, staff, disabled, pendingFor, onPick,
}: {
  summary: React.ReactNode;
  staff: QuickAddStaffOption[];
  disabled: boolean;
  pendingFor: string | null;
  onPick: (s: QuickAddStaffOption) => void;
}) {
  return (
    <div>
      {summary}
      <ul className="space-y-3">
        {staff.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              data-staff-option
              disabled={disabled}
              onClick={() => onPick(s)}
              className="flex w-full items-center justify-between rounded-xl border border-slate-300
                         bg-white px-4 py-4 text-left text-base font-medium text-slate-900 transition
                         hover:border-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed
                         disabled:opacity-60"
            >
              <span>{s.name}</span>
              <span className="text-sm font-normal text-slate-500">
                {pendingFor === s.id ? "Booking…" : "Assign"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Choosing a team member books the appointment straight away.
      </p>
    </div>
  );
}

/** Only reached when a staff member belongs to more than one workspace this
 *  caller can see. Guessing the attribution would be worse than asking. */
function WorkspaceStep({
  options, disabled, onPick,
}: {
  options: Array<{ id: string; name: string }>;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <p className="mb-3 text-sm text-slate-600">
        Which team should this appointment belong to?
      </p>
      <ul className="space-y-3">
        {options.map((w) => (
          <li key={w.id}>
            <button
              type="button"
              data-workspace-option
              disabled={disabled}
              onClick={() => onPick(w.id)}
              className="w-full rounded-xl border border-slate-300 bg-white px-4 py-4 text-left
                         text-base font-medium text-slate-900 transition hover:border-slate-900
                         hover:bg-slate-50 disabled:opacity-60"
            >
              {w.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  label, htmlFor, error, children,
}: {
  label: string; htmlFor: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
