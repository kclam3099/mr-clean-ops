import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getInvoice } from "@/lib/invoices/queries";
import { invoiceFileName } from "@/lib/invoices/xlsx";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { PrintButton } from "@/components/invoices/PrintButton";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const invoice = await getInvoice((await params).id);
  // The document title becomes the suggested PDF file name when saving.
  return { title: invoice ? invoiceFileName(invoice, "pdf").replace(/\.pdf$/, "") : "Invoice" };
}

/**
 * The invoice as a printable page, matching the owner's Excel design — so it
 * can be saved as a PDF from any phone or computer ("Print" -> "Save as PDF")
 * without Excel. Same RLS-bound read as the Excel download.
 */
export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  const invoice = await getInvoice((await params).id);
  if (!invoice) notFound();


  return (
    <div className="min-h-screen bg-white text-[#2B3440] print:bg-white">
      <div className="mx-auto flex max-w-[52rem] justify-end gap-2 px-4 pt-4 print:hidden">
        <PrintButton />
      </div>

      <InvoiceDocument invoice={invoice} />
    </div>
  );
}
