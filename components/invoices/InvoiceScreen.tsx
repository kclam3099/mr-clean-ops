import Link from "next/link";
import type { SessionContext } from "@/lib/auth/session";
import { getAppointmentDetail } from "@/lib/appointments/detail";
import { getInvoiceForAppointment, type Invoice } from "@/lib/invoices/queries";
import { businessToday } from "@/lib/agenda/queries";
import { getI18n } from "@/lib/i18n/server";
import { InvoiceEditor, type InvoiceDraft } from "./InvoiceEditor";
import { invoiceMoney } from "@/lib/invoices/money";

/** The service line the owner's invoices carry unless someone changes it. */
const DEFAULT_SERVICE = "Deep Cleaning + High Temperature Steam";

/**
 * "Request invoice" for one job — shared by the Master and staff routes.
 *
 * The job must be visible (RLS: hidden and missing read the same) and
 * completed; save_invoice enforces both again. The form starts from the
 * existing invoice when there is one, otherwise from the job itself.
 */
export async function InvoiceScreen({
  session,
  appointmentId,
  backHref,
}: {
  session: SessionContext;
  appointmentId: string;
  backHref: string;
}) {
  const { t } = await getI18n();
  const detail = await getAppointmentDetail(session, appointmentId);

  if (!detail) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-lg font-semibold text-ink">{t("Appointment not available")}</h1>
        <Link href={backHref} className="mt-6 inline-block text-sm text-brand underline">{t("Back")}</Link>
      </div>
    );
  }

  const invoice = await getInvoiceForAppointment(appointmentId);
  const canInvoice = session.isMaster || detail.isOwnAppointment;

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            {invoice ? t("Invoice {no}", { no: invoice.invoiceNo }) : t("Request invoice")}
          </h1>
          <p className="truncate text-sm text-ink-muted">{detail.customerName} · {detail.date}</p>
        </div>
        <Link href={backHref}
          className="shrink-0 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-ink transition hover:bg-sunken">
          {t("Back")}
        </Link>
      </div>

      {detail.status !== "completed" || !canInvoice ? (
        <p className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
          {t("Mark the job completed before requesting an invoice.")}
        </p>
      ) : invoice && !session.isMaster ? (
        // Issued: the staff member can open and send it, a Master changes it (0019).
        <IssuedInvoice invoice={invoice} />
      ) : (
        <InvoiceEditor
          appointmentId={appointmentId}
          initial={invoice ? fromInvoice(invoice) : {
            invoiceDate: businessToday(),
            billToName: detail.customerName,
            billToAddress: joinAddress(detail.addressLine, detail.areaCity),
            serviceTitle: DEFAULT_SERVICE,
            items: [
              ...detail.items.map((i) => ({
                description: i.quantity > 1 ? `${i.description} x${i.quantity}` : i.description,
                amount: String(Math.round(i.lineTotal)),
              })),
              ...detail.addons.map((a) => ({ description: a.description, amount: String(Math.round(a.amount)) })),
            ].slice(0, 12),
            discountMode: "none",
            discountValue: "",
          }}
          saved={invoice ? { id: invoice.id, no: invoice.invoiceNo } : null}
          canDelete={session.isMaster}
          afterDeleteHref={backHref}
        />
      )}
    </div>
  );
}

/** An issued invoice as the staff member sees it: read-only, with the downloads. */
async function IssuedInvoice({ invoice }: { invoice: Invoice }) {
  const { t } = await getI18n();
  return (
    <div className="space-y-4" data-invoice-readonly>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-ok/40 bg-ok/5 px-4 py-3">
        <p className="text-sm font-semibold text-ok">{t("Invoice {no}", { no: invoice.invoiceNo })}</p>
        <div className="flex flex-wrap gap-2">
          <a href={`/invoices/${invoice.id}/xlsx`}
            className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700">
            {t("Download Excel")}
          </a>
          <a href={`/invoices/${invoice.id}/print`} target="_blank" rel="noopener"
            className="rounded-lg border border-line bg-card px-3 py-2 text-sm font-semibold text-ink transition hover:bg-sunken">
            {t("PDF / Print")}
          </a>
        </div>
      </div>
      <section className="space-y-1 rounded-xl border border-line bg-card p-4 text-sm">
        <p className="font-semibold text-ink">{invoice.billToName}</p>
        {invoice.billToAddress ? <p className="text-ink-muted">{invoice.billToAddress}</p> : null}
        <ul className="mt-2 divide-y divide-line">
          {invoice.items.map((i, n) => (
            <li key={n} className="flex justify-between gap-3 py-1.5">
              <span>{i.description}</span><span className="tabular-nums">{invoiceMoney(i.amount)}</span>
            </li>
          ))}
        </ul>
        {invoice.discountLabel ? (
          <p className="flex justify-between text-warn"><span>{invoice.discountLabel}</span><span>−{invoiceMoney(invoice.discountAmount)}</span></p>
        ) : null}
        <p className="flex justify-between border-t border-line pt-2 text-base font-bold">
          <span>{t("Total")}</span><span className="tabular-nums text-brand">{invoiceMoney(invoice.total)}</span>
        </p>
      </section>
      <p className="text-xs text-ink-muted">{t("Only a Master can change an issued invoice.")}</p>
    </div>
  );
}

function joinAddress(line: string | null, area: string | null): string {
  if (!line) return area ?? "";
  if (!area || line.toLowerCase().includes(area.toLowerCase())) return line;
  return `${line}, ${area}`;
}

function fromInvoice(inv: Invoice): InvoiceDraft {
  const pct = inv.discountLabel?.match(/^Discount\s+(\d+(?:\.\d+)?)%$/i);
  return {
    invoiceDate: inv.date,
    billToName: inv.billToName,
    billToAddress: inv.billToAddress ?? "",
    serviceTitle: inv.serviceTitle ?? "",
    items: inv.items.map((i) => ({ description: i.description, amount: String(Math.round(i.amount)) })),
    discountMode: pct ? "percent" : inv.discountAmount > 0 ? "amount" : "none",
    discountValue: pct ? (pct[1] as string) : inv.discountAmount > 0 ? String(Math.round(inv.discountAmount)) : "",
  };
}
