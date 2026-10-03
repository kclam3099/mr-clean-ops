import { getSessionContext } from "@/lib/auth/session";
import { getInvoice } from "@/lib/invoices/queries";
import { buildInvoiceXlsx, invoiceFileName } from "@/lib/invoices/xlsx";

/**
 * The invoice as the owner's own Excel template, filled in. Read through RLS:
 * someone who cannot see the appointment gets 404, the same as for an id that
 * does not exist.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) return new Response("Not signed in", { status: 401 });

  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return new Response("Not found", { status: 404 });

  const bytes = await buildInvoiceXlsx(invoice);
  const name = invoiceFileName(invoice, "xlsx");
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // RFC 5987 so a customer name with non-ASCII characters survives.
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
