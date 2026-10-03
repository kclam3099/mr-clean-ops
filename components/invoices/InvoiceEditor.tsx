"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveInvoiceAction, deleteInvoiceAction, type SaveInvoiceResult } from "@/lib/invoices/actions";
import type { AppError } from "@/lib/errors/appError";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useT } from "@/components/i18n/I18nProvider";
import { invoiceMoney, wholeRinggit } from "@/lib/invoices/money";

/**
 * Request / edit the invoice of one completed job.
 *
 * Prefilled from the job — customer, address, its services and add-ons — and
 * every line can be changed before saving, because what is invoiced is not
 * always exactly what was booked (a company name instead of the contact, a
 * combined line, a discount agreed on the day). The first save assigns the
 * next MRC number; saving again keeps it and updates the details.
 */

export type InvoiceDraft = {
  invoiceDate: string;
  billToName: string;
  billToAddress: string;
  serviceTitle: string;
  items: Array<{ description: string; amount: string }>;
  discountMode: "none" | "percent" | "amount";
  discountValue: string;
};

type Saved = { id: string; no: string } | null;

export function InvoiceEditor({
  appointmentId,
  initial,
  saved: initialSaved,
  canDelete = false,
  afterDeleteHref,
}: {
  appointmentId: string;
  initial: InvoiceDraft;
  saved: Saved;
  /** A Master of the job's workspace (0019); the database checks again. */
  canDelete?: boolean;
  afterDeleteHref: string;
}) {
  const { t } = useT();
  const router = useRouter();
  const [draft, setDraft] = useState<InvoiceDraft>(initial);
  const [saved, setSaved] = useState<Saved>(initialSaved);
  const [result, setResult] = useState<SaveInvoiceResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<AppError | null>(null);

  // Whole ringgit throughout: items, the discount and the total are rounded to
  // the nearest RM, so the invoice never carries sen ("RM111", not "RM111.20").
  const num = (s: string) => Number(String(s).replace(/,/g, "").trim()) || 0;
  const subtotal = draft.items.reduce((s, i) => s + wholeRinggit(i.amount), 0);
  const discountAmount =
    draft.discountMode === "percent" ? Math.round((subtotal * num(draft.discountValue)) / 100)
    : draft.discountMode === "amount" ? wholeRinggit(draft.discountValue) : 0;
  const discountLabel =
    draft.discountMode === "percent" && num(draft.discountValue) > 0 ? `Discount ${num(draft.discountValue)}%`
    : draft.discountMode === "amount" && num(draft.discountValue) > 0 ? `Discount ${invoiceMoney(wholeRinggit(draft.discountValue))}`
    : "";
  const total = Math.max(0, subtotal - discountAmount);

  const field = (n: string) => {
    const msg = result?.status === "error" ? result.fields?.[n] : undefined;
    return msg ? t(msg) : undefined;
  };
  const set = (patch: Partial<InvoiceDraft>) => { setDraft((d) => ({ ...d, ...patch })); setResult(null); };
  const setItem = (i: number, patch: Partial<InvoiceDraft["items"][number]>) =>
    set({ items: draft.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });

  function save() {
    if (pending) return;
    startTransition(async () => {
      const res = await saveInvoiceAction({
        appointmentId,
        invoiceDate: draft.invoiceDate,
        billToName: draft.billToName,
        billToAddress: draft.billToAddress,
        serviceTitle: draft.serviceTitle,
        items: draft.items.map((i) => ({ description: i.description, amount: wholeRinggit(i.amount) })),
        discountLabel,
        discountAmount,
      });
      setResult(res);
      if (res.status === "success") {
        setSaved({ id: res.invoiceId, no: res.invoiceNo });
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4" data-invoice-editor>
      {saved ? (
        <div data-invoice-saved className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-ok/40 bg-ok/5 px-4 py-3">
          <p className="text-sm font-semibold text-ok">
            {t("Invoice {no}", { no: saved.no })}
            {result?.status === "success" ? <span className="ml-2 font-normal">{t("saved")}</span> : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`/invoices/${saved.id}/xlsx`} data-invoice-xlsx
              className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700">
              {t("Download Excel")}
            </a>
            <a href={`/invoices/${saved.id}/print`} target="_blank" rel="noopener" data-invoice-print
              className="rounded-lg border border-line bg-card px-3 py-2 text-sm font-semibold text-ink transition hover:bg-sunken">
              {t("PDF / Print")}
            </a>
          </div>
        </div>
      ) : null}

      {result?.status === "error" && !result.fields ? <ErrorNotice error={result.error} /> : null}

      <section className="space-y-3 rounded-xl border border-line bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Bill to")} error={field("billToName")}>
            <input value={draft.billToName} onChange={(e) => set({ billToName: e.target.value })} maxLength={200} className={inputClass} />
          </Field>
          <Field label={t("Invoice date")} error={field("invoiceDate")}>
            <input type="date" value={draft.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} className={inputClass} />
          </Field>
        </div>
        <Field label={t("Address")} error={field("billToAddress")}>
          <textarea rows={2} value={draft.billToAddress} onChange={(e) => set({ billToAddress: e.target.value })} maxLength={500} className={inputClass} />
        </Field>
        <Field label={t("Service / details")} error={field("serviceTitle")}>
          <input value={draft.serviceTitle} onChange={(e) => set({ serviceTitle: e.target.value })} maxLength={200} className={inputClass} />
        </Field>
      </section>

      <section className="space-y-2 rounded-xl border border-line bg-card p-4">
        <h2 className="text-sm font-semibold text-ink">{t("Items")}</h2>
        {draft.items.map((it, i) => (
          <div key={i} className="flex items-start gap-2" data-invoice-item={i}>
            <div className="min-w-0 flex-1">
              <input value={it.description} placeholder={t("e.g. QUEEN BED")} maxLength={120}
                onChange={(e) => setItem(i, { description: e.target.value })} className={inputClass} aria-label={t("Item")} />
              {field(`items.${i}.description`) ? <p className="mt-1 text-sm text-red-600">{field(`items.${i}.description`)}</p> : null}
            </div>
            <div className="w-28 shrink-0">
              <input inputMode="numeric" value={it.amount} placeholder="0"
                onChange={(e) => setItem(i, { amount: e.target.value })} className={`${inputClass} text-right`} aria-label={t("Amount (RM)")} />
              {field(`items.${i}.amount`) ? <p className="mt-1 text-sm text-red-600">{field(`items.${i}.amount`)}</p> : null}
            </div>
            <button type="button" disabled={draft.items.length <= 1}
              onClick={() => set({ items: draft.items.filter((_, j) => j !== i) })}
              aria-label={t("Remove item")}
              className="mt-2 cursor-pointer rounded px-2 py-1 text-ink-faint transition hover:bg-red-50 hover:text-red-700 disabled:opacity-30">
              ✕
            </button>
          </div>
        ))}
        {field("items") ? <p className="text-sm text-red-600">{field("items")}</p> : null}
        {draft.items.length < 12 ? (
          <button type="button" onClick={() => set({ items: [...draft.items, { description: "", amount: "" }] })}
            className="cursor-pointer rounded-lg border border-dashed border-line px-3 py-2 text-sm font-medium text-ink-muted transition hover:bg-sunken hover:text-ink">
            {t("+ Add item")}
          </button>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="text-sm font-medium text-ink">{t("Discount")}</span>
          <select value={draft.discountMode} onChange={(e) => set({ discountMode: e.target.value as InvoiceDraft["discountMode"] })}
            className="min-h-10 rounded-lg border border-line bg-card px-2 text-sm">
            <option value="none">{t("None")}</option>
            <option value="percent">%</option>
            <option value="amount">RM</option>
          </select>
          {draft.discountMode !== "none" ? (
            <input inputMode="decimal" value={draft.discountValue} onChange={(e) => set({ discountValue: e.target.value })}
              className="min-h-10 w-24 rounded-lg border border-line bg-card px-3 text-right text-sm" aria-label={t("Discount")} />
          ) : null}
          {field("discountAmount") ? <p className="w-full text-sm text-red-600">{field("discountAmount")}</p> : null}
        </div>

        <dl className="space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between"><dt className="text-ink-muted">{t("Subtotal")}</dt><dd className="tabular-nums">{invoiceMoney(subtotal)}</dd></div>
          {discountAmount > 0 ? (
            <div className="flex justify-between text-warn"><dt>{discountLabel}</dt><dd className="tabular-nums">−{invoiceMoney(discountAmount)}</dd></div>
          ) : null}
          <div className="flex justify-between text-base font-bold"><dt>{t("Total")}</dt><dd data-invoice-total className="tabular-nums text-brand">{invoiceMoney(total)}</dd></div>
        </dl>
      </section>

      <button type="button" onClick={save} disabled={pending}
        className="w-full cursor-pointer rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50">
        {pending ? t("Saving…") : saved ? t("Save changes") : t("Create invoice")}
      </button>

      {deleteError ? <ErrorNotice error={deleteError} /> : null}
      {saved && canDelete ? (
        <button type="button" disabled={pending} data-invoice-delete
          onClick={() => {
            if (!window.confirm(t("Delete invoice {no}? The number will not be used again.", { no: saved.no }))) return;
            startTransition(async () => {
              const res = await deleteInvoiceAction({ invoiceId: saved.id, appointmentId });
              if (res.status === "success") {
                router.push(afterDeleteHref);
                router.refresh();
              } else {
                setDeleteError(res.error);
              }
            });
          }}
          className="w-full cursor-pointer rounded-xl border border-red-300 bg-card px-4 py-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50">
          {t("Delete invoice")}
        </button>
      ) : null}
    </div>
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
