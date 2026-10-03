import Link from "next/link";
import type { SessionContext } from "@/lib/auth/session";
import { getAppointmentDetail } from "@/lib/appointments/detail";
import { getInvoiceForAppointment, type Invoice } from "@/lib/invoices/queries";
import { businessToday } from "@/lib/agenda/queries";
import { getI18n } from "@/lib/i18n/server";
import { InvoiceEditor, type InvoiceDraft } from "./InvoiceEditor";

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
                amount: i.lineTotal.toFixed(2),
              })),
              ...detail.addons.map((a) => ({ description: a.description, amount: a.amount.toFixed(2) })),
            ].slice(0, 12),
            discountMode: "none",
            discountValue: "",
          }}
          saved={invoice ? { id: invoice.id, no: invoice.invoiceNo } : null}
        />
      )}
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
    items: inv.items.map((i) => ({ description: i.description, amount: i.amount.toFixed(2) })),
    discountMode: pct ? "percent" : inv.discountAmount > 0 ? "amount" : "none",
    discountValue: pct ? (pct[1] as string) : inv.discountAmount > 0 ? inv.discountAmount.toFixed(2) : "",
  };
}
