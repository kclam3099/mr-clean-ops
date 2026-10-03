import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { InvoiceDoc } from "./xlsx";

/**
 * Invoices (migration 0018), read through RLS: an invoice is exactly as
 * visible as its appointment. A missing table (app ahead of the migration)
 * reads as "no invoice" rather than an error.
 */

export type Invoice = InvoiceDoc & {
  id: string;
  appointmentId: string;
};

type Row = {
  id: string;
  appointment_id: string;
  invoice_no: string;
  invoice_date: string;
  bill_to_name: string;
  bill_to_address: string | null;
  service_title: string | null;
  items: Array<{ description: string; amount: number | string }>;
  discount_label: string | null;
  discount_amount: number | string;
  total: number | string;
};

const SELECT =
  "id, appointment_id, invoice_no, invoice_date, bill_to_name, bill_to_address, " +
  "service_title, items, discount_label, discount_amount, total";

function toInvoice(r: Row): Invoice {
  return {
    id: r.id,
    appointmentId: r.appointment_id,
    invoiceNo: r.invoice_no,
    date: r.invoice_date,
    billToName: r.bill_to_name,
    billToAddress: r.bill_to_address,
    serviceTitle: r.service_title,
    items: (r.items ?? []).map((i) => ({ description: i.description, amount: Number(i.amount) })),
    discountLabel: r.discount_label,
    discountAmount: Number(r.discount_amount),
    total: Number(r.total),
  };
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function getInvoiceForAppointment(appointmentId: string): Promise<Invoice | null> {
  if (!isUuid(appointmentId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("invoices").select(SELECT).eq("appointment_id", appointmentId).maybeSingle();
  if (error || !data) return null;
  return toInvoice(data as unknown as Row);
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  if (!isUuid(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("invoices").select(SELECT).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return toInvoice(data as unknown as Row);
}

/** Invoice numbers for a set of appointments — for the customer records ledger. */
export async function getInvoiceNumbers(appointmentIds: string[]): Promise<Map<string, { id: string; no: string }>> {
  const out = new Map<string, { id: string; no: string }>();
  if (appointmentIds.length === 0) return out;
  const supabase = await createClient();
  for (let i = 0; i < appointmentIds.length; i += 200) {
    const { data } = await supabase
      .from("invoices")
      .select("id, appointment_id, invoice_no")
      .in("appointment_id", appointmentIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; appointment_id: string; invoice_no: string }>) {
      out.set(r.appointment_id, { id: r.id, no: r.invoice_no });
    }
  }
  return out;
}
