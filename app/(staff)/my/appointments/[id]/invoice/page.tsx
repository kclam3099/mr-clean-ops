import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { InvoiceScreen } from "@/components/invoices/InvoiceScreen";

export const metadata = { title: "Invoice — Mr Clean & Clean Ops" };

export default async function StaffInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  const { id } = await params;
  return <InvoiceScreen session={session} appointmentId={id} backHref={`/my/appointments/${id}`} />;
}
