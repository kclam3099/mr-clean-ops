"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveStatementAction, deleteStatementAction } from "@/lib/statements/actions";
import type { AppError } from "@/lib/errors/appError";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useT } from "@/components/i18n/I18nProvider";
import { invoiceMoney } from "@/lib/invoices/money";

export type StatementDraft = {
  staffId: string;
  issueDate: string;
  periodFrom: string;
  periodTo: string;
  contractorName: string;
  contractorIdNumber: string;
  contractorContact: string;
  lines: Array<{ date: string; description: string; amount: string }>;
  deductions: Array<{ label: string; amount: string }>;
  paymentMethod: string;
  paymentReference: string;
  paymentDate: string;
};

export type ContractorOption = {
  staffId: string; displayName: string; legalName: string | null; idNumber: string | null; phone: string | null;
};

const METHODS = ["Bank Transfer", "DuitNow Transfer", "Cash", "Cheque"];

/**
 * Create / edit a Statement of Services Rendered. KC only (the page and the
 * database both check). Totals here are a preview; the database computes the
 * stored ones.
 */
export function StatementEditor({
  statementId, statementNo, initial, contractors,
}: {
  statementId: string | null;
  statementNo: string | null;
  initial: StatementDraft;
  contractors: ContractorOption[];
}) {
  const { t } = useT();
  const router = useRouter();
  const [d, setD] = useState<StatementDraft>(initial);
  const [error, setError] = useState<AppError | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const num = (s: string) => Number(String(s).replace(/,/g, "")) || 0;
  const gross = d.lines.reduce((s, l) => s + num(l.amount), 0);
  const deducted = d.deductions.reduce((s, x) => s + num(x.amount), 0);
  const net = gross - deducted;
  const set = (patch: Partial<StatementDraft>) => { setD((v) => ({ ...v, ...patch })); setError(null); setFields({}); };
  const err = (k: string) => (fields[k] ? t(fields[k]) : undefined);

  function pickContractor(staffId: string) {
    const c = contractors.find((x) => x.staffId === staffId);
    set({
      staffId,
      contractorName: c?.legalName ?? c?.displayName ?? "",
      contractorIdNumber: c?.idNumber ?? "",
      contractorContact: c?.phone ?? "",
    });
  }

  function save() {
    if (pending) return;
    startTransition(async () => {
      const res = await saveStatementAction({ statementId, ...d });
      if (res.status === "success") {
        router.push(`/statements/${res.statementId}`);
        router.refresh();
      } else {
        setError(res.fields ? null : res.error);
        setFields(res.fields ?? {});
      }
    });
  }

  return (
    <div className="space-y-4" data-statement-editor>
      {statementId && statementNo ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-ok/40 bg-ok/5 px-4 py-3">
          <p className="text-sm font-semibold text-ok">{t("Statement {no}", { no: statementNo })}</p>
          <a href={`/statements/${statementId}/print`} target="_blank" rel="noopener"
            className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700">
            {t("PDF / Print")}
          </a>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

      <section className="grid gap-3 rounded-xl border border-line bg-card p-4 sm:grid-cols-2">
        <F label={t("Contractor")}>
          <select value={d.staffId} onChange={(e) => pickContractor(e.target.value)} className={inputClass}>
            {contractors.map((c) => <option key={c.staffId} value={c.staffId}>{c.displayName}</option>)}
          </select>
        </F>
        <F label={t("Date of issue")} error={err("issueDate")}>
          <input type="date" value={d.issueDate} onChange={(e) => set({ issueDate: e.target.value })} className={inputClass} />
        </F>
        <F label={t("Full name (as per IC)")} error={err("contractorName")}>
          <input value={d.contractorName} onChange={(e) => set({ contractorName: e.target.value })} maxLength={200} className={inputClass} />
        </F>
        <F label={t("IC / Passport No.")} error={err("contractorIdNumber")}>
          <input value={d.contractorIdNumber} onChange={(e) => set({ contractorIdNumber: e.target.value })} maxLength={40} className={inputClass} />
        </F>
        <F label={t("Contact")} error={err("contractorContact")}>
          <input value={d.contractorContact} onChange={(e) => set({ contractorContact: e.target.value })} maxLength={200} className={inputClass} />
        </F>
        <div className="grid grid-cols-2 gap-2">
          <F label={t("Period from")}><input type="date" value={d.periodFrom} onChange={(e) => set({ periodFrom: e.target.value })} className={inputClass} /></F>
          <F label={t("Period to")}><input type="date" value={d.periodTo} onChange={(e) => set({ periodTo: e.target.value })} className={inputClass} /></F>
        </div>
      </section>

      <section className="space-y-2 rounded-xl border border-line bg-card p-4">
        <h2 className="text-sm font-semibold text-ink">{t("Services rendered")}</h2>
        {d.lines.map((l, i) => (
          // Phone: date and fee on one row, the description full-width below.
          // Wider: date | description | fee | remove on one row.
          <div key={i} className="grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem_auto] items-start gap-2 border-b border-line/60 pb-2 sm:grid-cols-[8.5rem_minmax(0,1fr)_6.5rem_auto] sm:border-0 sm:pb-0" data-statement-line={i}>
            <input type="date" value={l.date} aria-label={t("Date of service")}
              onChange={(e) => set({ lines: d.lines.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)) })} className={inputClass} />
            <div className="col-span-3 row-start-2 min-w-0 sm:col-span-1 sm:row-start-1">
              <input value={l.description} maxLength={300} placeholder={t("Description of cleaning work")} aria-label={t("Description of cleaning work")}
                onChange={(e) => set({ lines: d.lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} className={inputClass} />
              {err(`lines.${i}.description`) ? <p className="mt-1 text-sm text-red-600">{err(`lines.${i}.description`)}</p> : null}
            </div>
            <input inputMode="decimal" value={l.amount} placeholder="0" aria-label={t("Gross service fee")}
              onChange={(e) => set({ lines: d.lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} className={`${inputClass} text-right`} />
            <button type="button" disabled={d.lines.length <= 1} aria-label={t("Remove item")}
              onClick={() => set({ lines: d.lines.filter((_, j) => j !== i) })}
              className="mt-2 cursor-pointer rounded px-2 py-1 text-ink-faint hover:bg-red-50 hover:text-red-700 disabled:opacity-30">✕</button>
          </div>
        ))}
        {err("lines") ? <p className="text-sm text-red-600">{err("lines")}</p> : null}
        <button type="button" onClick={() => set({ lines: [...d.lines, { date: "", description: "", amount: "" }] })}
          className="cursor-pointer rounded-lg border border-dashed border-line px-3 py-2 text-sm font-medium text-ink-muted hover:bg-sunken hover:text-ink">
          {t("+ Add line")}
        </button>

        <h3 className="pt-3 text-sm font-semibold text-ink">{t("Deductions")}</h3>
        {d.deductions.map((x, i) => (
          <div key={i} className="grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem_auto] items-start gap-2">
            <input value={x.label} maxLength={120} placeholder={t("e.g. Advance paid")}
              onChange={(e) => set({ deductions: d.deductions.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} className={inputClass} />
            <input inputMode="decimal" value={x.amount} placeholder="0"
              onChange={(e) => set({ deductions: d.deductions.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)) })} className={`${inputClass} text-right`} />
            <button type="button" aria-label={t("Remove item")} onClick={() => set({ deductions: d.deductions.filter((_, j) => j !== i) })}
              className="mt-2 cursor-pointer rounded px-2 py-1 text-ink-faint hover:bg-red-50 hover:text-red-700">✕</button>
          </div>
        ))}
        {err("deductions") ? <p className="text-sm text-red-600">{err("deductions")}</p> : null}
        {d.deductions.length < 10 ? (
          <button type="button" onClick={() => set({ deductions: [...d.deductions, { label: "", amount: "" }] })}
            className="cursor-pointer rounded-lg border border-dashed border-line px-3 py-2 text-sm font-medium text-ink-muted hover:bg-sunken hover:text-ink">
            {t("+ Add deduction")}
          </button>
        ) : null}

        <dl className="space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between"><dt className="text-ink-muted">{t("Total gross fee")}</dt><dd className="tabular-nums">{invoiceMoney(gross)}</dd></div>
          <div className="flex justify-between text-warn"><dt>{t("Deductions")}</dt><dd className="tabular-nums">−{invoiceMoney(deducted)}</dd></div>
          <div className="flex justify-between text-base font-bold"><dt>{t("Net amount paid")}</dt><dd data-statement-net className="tabular-nums text-brand">{invoiceMoney(net)}</dd></div>
        </dl>
      </section>

      <section className="grid gap-3 rounded-xl border border-line bg-card p-4 sm:grid-cols-3">
        <F label={t("Payment method")}>
          <input list="statement-methods" value={d.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value })} maxLength={60} className={inputClass} />
          <datalist id="statement-methods">{METHODS.map((m) => <option key={m} value={m} />)}</datalist>
        </F>
        <F label={t("Transaction reference")} error={err("paymentReference")}>
          <input value={d.paymentReference} onChange={(e) => set({ paymentReference: e.target.value })} maxLength={200}
            placeholder={t("e.g. bank reference no.")} className={inputClass} />
        </F>
        <F label={t("Payment date")}>
          <input type="date" value={d.paymentDate} onChange={(e) => set({ paymentDate: e.target.value })} className={inputClass} />
        </F>
      </section>

      <button type="button" onClick={save} disabled={pending}
        className="w-full cursor-pointer rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50">
        {pending ? t("Saving…") : statementId ? t("Save changes") : t("Create statement")}
      </button>

      {statementId ? (
        <button type="button" disabled={pending}
          onClick={() => {
            if (!window.confirm(t("Delete statement {no}? The number will not be used again.", { no: statementNo ?? "" }))) return;
            startTransition(async () => {
              const res = await deleteStatementAction({ statementId });
              if (res.status === "success") { router.push("/statements"); router.refresh(); }
              else setError(res.error);
            });
          }}
          className="w-full cursor-pointer rounded-xl border border-red-300 bg-card px-4 py-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
          {t("Delete statement")}
        </button>
      ) : null}
    </div>
  );
}

function F({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-ink">{label}<span className="mt-1 block">{children}</span></label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-line bg-card px-3 py-2.5 text-base text-ink " +
  "focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue";
