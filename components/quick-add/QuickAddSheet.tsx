"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getQuickAddContextAction,
  quickAddCreateAction,
  type QuickAddContext,
  type QuickAddStaffOption,
} from "@/lib/appointments/quick-add-actions";
import {
  parseAppointmentMessage, flagPastDateTime, looksLikeAppointment,
  REQUIRED_FIELDS, type ParsedMessage, type ParsedField,
} from "@/lib/appointments/message-parser";
import { ItemsEditor, initialItemRow, type ItemRow } from "@/components/appointment-form/ItemsEditor";
import { OverrideDialog } from "@/components/appointment-form/OverrideDialog";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { AppErrorCode, type AppError } from "@/lib/errors/appError";
import { subtotal, formatMoney } from "@/lib/pricing/duration";

/**
 * Quick Add — paste the WhatsApp message, check it, tap a staff member.
 *
 * Most bookings arrive as semi-structured WhatsApp text, so pasting is the
 * primary path and the structured form is the correction path. Pasting parses
 * immediately: no "Detect" button on the normal flow.
 *
 * The rules this component exists to keep:
 *
 *   - Tapping a staff card means ASSIGN + CREATE. No second Save, and no
 *     availability pre-check — `find_available_slots` is standard-job only, so
 *     a pre-check could disagree with the real job's duration, and making it
 *     amount-aware would reintroduce the oracle closed in 0007.
 *
 *   - A refused booking never costs the typing OR the paste. Everything lives
 *     here and is re-sent on each attempt; only the staff choice is retried.
 *
 *   - The pasted text is untrusted data. It is rendered as text, never markup,
 *     and the parser's output has no staff, workspace or role field for a line
 *     like `Staff: Victor` to land in.
 */

type Step = "paste" | "review" | "details" | "assign" | "workspace";

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

/** Parser field names to the form's field names, for highlighting. */
const FIELD_MAP: Record<ParsedField, keyof Details | "items"> = {
  customerName: "customerName", phone: "customerPhone", address: "addressLine",
  areaCity: "areaCity", date: "apptDate", time: "startTime", items: "items",
};

const emptyDetails = (): Details => ({
  customerName: "", customerPhone: "", addressLine: "", areaCity: "",
  apptDate: "", startTime: "", remarks: "", items: [initialItemRow()],
});

function detailsFromParsed(p: ParsedMessage): Details {
  return {
    customerName: p.customerName,
    customerPhone: p.phone,
    addressLine: p.address,
    areaCity: p.areaCity,
    apptDate: p.date,
    startTime: p.time,
    remarks: p.remarks,
    items: p.items.length
      ? p.items.map((it, i) => ({
          key: `parsed-${i}`,
          description: it.description,
          quantity: String(it.quantity),
          unitPrice: String(it.unitPrice),
        }))
      : [initialItemRow()],
  };
}

export function QuickAddSheet({
  businessToday,
  businessNow,
  onClose,
  onSuccess,
}: {
  businessToday: string;
  /** Business-local "YYYY-MM-DDTHH:MM", for the past-datetime hint. */
  businessNow: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const router = useRouter();
  const [context, setContext] = useState<QuickAddContext | null>(null);
  const [step, setStep] = useState<Step>("paste");
  const [rawText, setRawText] = useState("");
  const [details, setDetails] = useState<Details>(emptyDetails);
  const [confirmations, setConfirmations] = useState<ParsedField[]>([]);
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
    getQuickAddContextAction().then((c) => { if (!cancelled) setContext(c); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.querySelector<HTMLElement>("textarea, input, button")?.focus();

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

  /** Parse the pasted message and go straight to the review. */
  function detect(text: string) {
    setRawText(text);
    const parsed = flagPastDateTime(parseAppointmentMessage(text), businessNow);
    if (!looksLikeAppointment(parsed)) return;
    setDetails(detailsFromParsed(parsed));
    setConfirmations([...parsed.confirmationFields]);
    setError(null);
    setStep("review");
  }

  /**
   * Required fields that are not yet settled — either empty, or parsed with low
   * enough confidence that the owner should look. Assignment is blocked until
   * this is empty, because every one of them is NOT NULL in the database.
   */
  function outstanding(): ParsedField[] {
    const empty: ParsedField[] = [];
    if (!details.customerName.trim()) empty.push("customerName");
    if (!details.customerPhone.trim()) empty.push("phone");
    if (!details.addressLine.trim()) empty.push("address");
    if (!details.areaCity.trim()) empty.push("areaCity");
    if (!details.apptDate) empty.push("date");
    if (!details.startTime) empty.push("time");
    if (!details.items.some((i) => i.description.trim() && i.unitPrice !== "")) empty.push("items");
    return REQUIRED_FIELDS.filter((f) => empty.includes(f) || confirmations.includes(f));
  }

  const issues = outstanding();
  const highlight = new Set(issues.map((f) => FIELD_MAP[f]));

  /** Opening the editor satisfies a "please look at this" flag. */
  function openEditor() {
    setConfirmations([]);
    setError(null);
    setStep("details");
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
      router.refresh();
      onClose();
      return;
    }

    if (result.status === "needsWorkspace") {
      setWorkspaceOptions(result.workspaces);
      setStep("workspace");
      return;
    }

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

    // Unavailable, overlap, working hours, time off, past — back to the choice
    // with the paste and every edited field intact.
    setError(result.error);
    setStep(isStaffMode ? "review" : "assign");
  }

  const assignList =
    context?.mode === "master" ? (
      <AssignStep
        staff={context.staff}
        disabled={pending}
        pendingFor={pending ? chosenStaff?.id ?? null : null}
        onPick={(s) => { setChosenStaff(s); void submit(s); }}
      />
    ) : null;

  const heading =
    step === "paste" ? "New appointment"
    : step === "review" ? "Review"
    : step === "details" ? "Appointment details"
    : step === "assign" ? "Assign to"
    : "Which team?";

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
          <h2 id="quick-add-title" className="text-base font-semibold text-slate-900">{heading}</h2>
          <button
            type="button" onClick={onClose} disabled={pending} aria-label="Close"
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

              {step === "paste" ? (
                <PasteStep
                  value={rawText}
                  disabled={pending}
                  onDetect={detect}
                  onManual={() => { setDetails(emptyDetails()); setStep("details"); }}
                />
              ) : null}

              {step === "review" ? (
                <ReviewStep
                  details={details}
                  total={total}
                  issues={issues}
                  onEdit={openEditor}
                  onBackToMessage={rawText ? () => setStep("paste") : undefined}
                  assign={assignList}
                  staffMode={isStaffMode}
                  saving={pending}
                  onSave={() => void submit(null)}
                />
              ) : null}

              {step === "details" ? (
                <DetailsStep
                  details={details}
                  setDetails={setDetails}
                  fields={fields}
                  highlight={highlight}
                  disabled={pending}
                  businessToday={businessToday}
                />
              ) : null}

              {step === "assign" ? (
                <>
                  <Summary details={details} total={total} onEdit={openEditor} />
                  {assignList}
                </>
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
              disabled={pending || issues.length > 0}
              onClick={() => {
                if (isStaffMode) { void submit(null); return; }
                setError(null);
                setStep(rawText ? "review" : "assign");
              }}
              className="w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-medium text-white
                         transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStaffMode
                ? (pending ? "Saving…" : "Save appointment")
                : rawText ? "Back to review" : "Assign staff →"}
            </button>
            {issues.length > 0 ? (
              <p className="mt-2 text-center text-xs text-slate-500">
                {issues.length} detail{issues.length === 1 ? "" : "s"} still needed.
              </p>
            ) : null}
          </footer>
        ) : null}
      </div>

      {overrideFor ? (
        <OverrideDialog
          error={overrideFor}
          pending={pending}
          onCancel={() => { setOverrideFor(null); setStep(isStaffMode ? "review" : "assign"); }}
          onConfirm={(reason) => { setOverrideFor(null); void submit(chosenStaff, undefined, reason); }}
        />
      ) : null}
    </div>
  );
}

/**
 * The primary entry point. Pasting parses immediately — the owner should not
 * have to press anything to see what was understood.
 */
function PasteStep({
  value, disabled, onDetect, onManual,
}: {
  value: string;
  disabled: boolean;
  onDetect: (text: string) => void;
  onManual: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  const [tried, setTried] = useState(false);

  return (
    <div className="space-y-3">
      <label htmlFor="qa-paste" className="block text-sm font-medium text-slate-700">
        Paste the appointment message
      </label>
      <textarea
        id="qa-paste"
        ref={ref}
        rows={12}
        value={text}
        disabled={disabled}
        // The value is not updated until after this event, so read it back on
        // the next tick rather than reconstructing it from the clipboard.
        onPaste={() => setTimeout(() => {
          const next = ref.current?.value ?? "";
          setText(next);
          setTried(true);
          onDetect(next);
        }, 0)}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Appointment Confirmed\n\nPuchong Utama\n\nName : Grace\nContact Number: 0148136726\nDate: 8/9/26\nAppt Time: 2pm\n\nAddress: …\n\nSofa 2 seater L RM179"}
        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-sm text-slate-900
                   placeholder:text-slate-300 focus:border-slate-900 focus:outline-none focus:ring-1
                   focus:ring-slate-900"
      />

      {tried && text.trim() ? (
        <p className="text-sm text-amber-800">
          That does not look like an appointment message yet. Check it, press
          Detect, or enter the details yourself.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || !text.trim()}
          onClick={() => { setTried(true); onDetect(text); }}
          className="min-h-11 rounded-xl bg-slate-900 px-5 text-sm font-medium text-white
                     transition hover:bg-slate-800 disabled:opacity-50"
        >
          Detect appointment
        </button>
        <button
          type="button"
          onClick={onManual}
          className="-my-2 py-2 text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900"
        >
          Enter manually instead
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Pasting detects the details automatically.
      </p>
    </div>
  );
}

/**
 * Review and assign on ONE screen. Splitting them would add a tap that shows
 * nothing new; the point of this flow is that it takes seconds.
 */
function ReviewStep({
  details, total, issues, onEdit, onBackToMessage, assign, staffMode, saving, onSave,
}: {
  details: Details;
  total: number;
  issues: ParsedField[];
  onEdit: () => void;
  onBackToMessage?: () => void;
  assign: React.ReactNode;
  staffMode: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const ready = issues.length === 0;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4" data-review-card>
        <p className="text-lg font-semibold text-slate-900">{details.customerName || "—"}</p>
        <p className="text-sm text-slate-600">{details.customerPhone || "—"}</p>

        <p className="mt-3 font-medium text-slate-900">
          {details.apptDate ? longDate(details.apptDate) : "Date needed"}
          {details.startTime ? ` · ${friendlyTime(details.startTime)}` : ""}
        </p>
        <p className="text-sm text-slate-600">{details.areaCity || "Area needed"}</p>

        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3">
          {details.items
            .filter((i) => i.description.trim() || i.unitPrice !== "")
            .map((i) => (
              <li key={i.key} className="flex justify-between gap-3 text-sm">
                <span className="min-w-0 text-slate-700">{i.description}</span>
                <span className="shrink-0 tabular-nums text-slate-900">
                  {formatMoney(Number(i.unitPrice) || 0)}
                </span>
              </li>
            ))}
          <li className="flex justify-between gap-3 border-t border-slate-100 pt-1 text-sm font-medium">
            <span>Total</span>
            <span className="tabular-nums">{formatMoney(total)}</span>
          </li>
        </ul>

        {details.addressLine ? (
          // Rendered as a text node. Untrusted pasted content is never markup.
          <p className="mt-3 whitespace-pre-line border-t border-slate-100 pt-3 text-sm text-slate-600">
            {details.addressLine}
          </p>
        ) : null}
        {details.remarks ? (
          <p className="mt-2 whitespace-pre-line text-sm text-slate-500">{details.remarks}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button" onClick={onEdit} data-review-edit
            className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700
                       transition hover:bg-slate-50"
          >
            Edit
          </button>
          {onBackToMessage ? (
            <button
              type="button" onClick={onBackToMessage}
              className="-my-2 py-2 text-sm text-slate-500 underline underline-offset-2 hover:text-slate-900"
            >
              Back to message
            </button>
          ) : null}
        </div>
      </div>

      {!ready ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            Please confirm {issues.length} detail{issues.length === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-sm text-amber-800">{issues.map(label).join(", ")}</p>
          <button
            type="button" onClick={onEdit} data-confirm-details
            className="mt-3 min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white
                       transition hover:bg-slate-800"
          >
            Confirm {issues.length === 1 ? "it" : "them"}
          </button>
        </div>
      ) : staffMode ? (
        <button
          type="button" onClick={onSave} disabled={saving}
          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-medium text-white
                     transition hover:bg-slate-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save appointment"}
        </button>
      ) : (
        <div>
          <h3 className="mb-2 text-sm font-medium text-slate-700">Assign to</h3>
          {assign}
        </div>
      )}
    </div>
  );
}

function label(field: ParsedField): string {
  return {
    customerName: "customer name", phone: "phone", address: "address",
    areaCity: "area / city", date: "date", time: "time", items: "service and price",
  }[field];
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(d);
}

function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  const suffix = (h as number) < 12 ? "AM" : "PM";
  const hour = (h as number) % 12 === 0 ? 12 : (h as number) % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
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
          type="button" onClick={onEdit}
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function DetailsStep({
  details, setDetails, fields, highlight, disabled, businessToday,
}: {
  details: Details;
  setDetails: (d: Details) => void;
  fields: Record<string, string>;
  highlight: Set<string>;
  disabled: boolean;
  businessToday: string;
}) {
  const set = (patch: Partial<Details>) => setDetails({ ...details, ...patch });
  const cls = (name: string) =>
    "w-full rounded-lg px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 " +
    "focus:outline-none focus:ring-1 focus:ring-slate-900 focus:border-slate-900 " +
    (highlight.has(name) ? "border-2 border-amber-400 bg-amber-50" : "border border-slate-300");

  return (
    <div className="space-y-4">
      <Field label="Customer name" htmlFor="qa-name" error={fields.customerName} flagged={highlight.has("customerName")}>
        <input id="qa-name" name="customerName" className={cls("customerName")} disabled={disabled}
          value={details.customerName} onChange={(e) => set({ customerName: e.target.value })} />
      </Field>
      <Field label="Phone / WhatsApp" htmlFor="qa-phone" error={fields.customerPhone} flagged={highlight.has("customerPhone")}>
        <input id="qa-phone" name="customerPhone" type="tel" inputMode="tel" className={cls("customerPhone")}
          disabled={disabled} value={details.customerPhone}
          onChange={(e) => set({ customerPhone: e.target.value })} />
      </Field>
      {/* A textarea, because pasted addresses are routinely multiline. */}
      <Field label="Address" htmlFor="qa-address" error={fields.addressLine} flagged={highlight.has("addressLine")}>
        <textarea id="qa-address" name="addressLine" rows={3} className={cls("addressLine")} disabled={disabled}
          value={details.addressLine} onChange={(e) => set({ addressLine: e.target.value })} />
      </Field>
      <Field label="Area / city" htmlFor="qa-area" error={fields.areaCity} flagged={highlight.has("areaCity")}>
        <input id="qa-area" name="areaCity" className={cls("areaCity")} disabled={disabled}
          value={details.areaCity} onChange={(e) => set({ areaCity: e.target.value })} />
      </Field>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Services</p>
        <ItemsEditor rows={details.items} onChange={(items) => set({ items })} errors={fields} disabled={disabled} />
      </div>

      <div className="flex gap-3">
        <Field label="Date" htmlFor="qa-date" error={fields.apptDate} flagged={highlight.has("apptDate")}>
          <input id="qa-date" name="apptDate" type="date" min={businessToday} className={cls("apptDate")}
            disabled={disabled} value={details.apptDate}
            onChange={(e) => set({ apptDate: e.target.value })} />
        </Field>
        <Field label="Time" htmlFor="qa-time" error={fields.startTime} flagged={highlight.has("startTime")}>
          <input id="qa-time" name="startTime" type="time" className={cls("startTime")} disabled={disabled}
            value={details.startTime} onChange={(e) => set({ startTime: e.target.value })} />
        </Field>
      </div>

      <Field label="Remarks (optional)" htmlFor="qa-remarks" error={fields.remarks}>
        <textarea id="qa-remarks" name="remarks" rows={2} className={cls("remarks")} disabled={disabled}
          value={details.remarks} onChange={(e) => set({ remarks: e.target.value })} />
      </Field>
    </div>
  );
}

/**
 * `staff` arrives already limited to what this caller may see. There is no
 * disabled entry, no count and no "hidden" placeholder — a Partner Master
 * simply receives a shorter list, with no way to tell it is shorter.
 */
function AssignStep({
  staff, disabled, pendingFor, onPick,
}: {
  staff: QuickAddStaffOption[];
  disabled: boolean;
  pendingFor: string | null;
  onPick: (s: QuickAddStaffOption) => void;
}) {
  return (
    <div>
      <ul className="space-y-3">
        {staff.map((s) => (
          <li key={s.id}>
            <button
              type="button" data-staff-option disabled={disabled} onClick={() => onPick(s)}
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
      <p className="mb-3 text-sm text-slate-600">Which team should this appointment belong to?</p>
      <ul className="space-y-3">
        {options.map((w) => (
          <li key={w.id}>
            <button
              type="button" data-workspace-option disabled={disabled} onClick={() => onPick(w.id)}
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
  label: text, htmlFor, error, flagged, children,
}: {
  label: string; htmlFor: string; error?: string; flagged?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
        {text}
        {flagged ? <span className="ml-2 text-xs font-normal text-amber-700">needs confirmation</span> : null}
      </label>
      {children}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
