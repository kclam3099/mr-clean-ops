import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { Statement } from "./types";

/**
 * Contractor statements (migration 0022). Every read here is through RLS, and
 * the tables only answer a Super Master — for anyone else they are empty, so a
 * page built on these reads shows nothing even if its own guard were missing.
 */

export type ContractorRow = {
  staffId: string;
  displayName: string;
  legalName: string | null;
  idNumber: string | null;
  phone: string | null;
  address: string | null;
};

export async function getContractors(): Promise<ContractorRow[]> {
  const supabase = await createClient();
  const [{ data: staff }, { data: profiles }] = await Promise.all([
    supabase.from("staff").select("id, display_name, phone, is_active").order("display_name"),
    supabase.from("contractor_profiles").select("staff_id, legal_name, id_number, phone, address"),
  ]);
  const byId = new Map((profiles ?? []).map((p) => [p.staff_id as string, p]));
  return (staff ?? [])
    .filter((s) => s.is_active)
    .map((s) => {
      const p = byId.get(s.id as string);
      return {
        staffId: s.id as string,
        displayName: s.display_name as string,
        legalName: (p?.legal_name as string | null) ?? null,
        idNumber: (p?.id_number as string | null) ?? null,
        phone: (p?.phone as string | null) ?? (s.phone as string | null) ?? null,
        address: (p?.address as string | null) ?? null,
      };
    });
}

type Row = {
  id: string; staff_id: string; statement_no: string; issue_date: string;
  period_from: string | null; period_to: string | null;
  contractor_name: string; contractor_id_number: string | null; contractor_contact: string | null;
  lines: Array<{ date: string | null; description: string; amount: number | string }>;
  gross_total: number | string;
  deductions: Array<{ label: string; amount: number | string }>;
  deduction_total: number | string; net_amount: number | string;
  payment_method: string | null; payment_reference: string | null; payment_date: string | null;
};

const SELECT =
  "id, staff_id, statement_no, issue_date, period_from, period_to, contractor_name, contractor_id_number, " +
  "contractor_contact, lines, gross_total, deductions, deduction_total, net_amount, payment_method, " +
  "payment_reference, payment_date";

function toStatement(r: Row): Statement {
  return {
    id: r.id,
    staffId: r.staff_id,
    statementNo: r.statement_no,
    issueDate: r.issue_date,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    contractorName: r.contractor_name,
    contractorIdNumber: r.contractor_id_number,
    contractorContact: r.contractor_contact,
    lines: (r.lines ?? []).map((l) => ({ date: l.date, description: l.description, amount: Number(l.amount) })),
    grossTotal: Number(r.gross_total),
    deductions: (r.deductions ?? []).map((d) => ({ label: d.label, amount: Number(d.amount) })),
    deductionTotal: Number(r.deduction_total),
    netAmount: Number(r.net_amount),
    paymentMethod: r.payment_method,
    paymentReference: r.payment_reference,
    paymentDate: r.payment_date,
  };
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function getStatements(): Promise<Statement[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("contractor_statements").select(SELECT)
    .order("statement_number", { ascending: false }).limit(200);
  return ((data ?? []) as unknown as Row[]).map(toStatement);
}

export async function getStatement(id: string): Promise<Statement | null> {
  if (!isUuid(id)) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("contractor_statements").select(SELECT).eq("id", id).maybeSingle();
  return data ? toStatement(data as unknown as Row) : null;
}

/**
 * The contractor's completed jobs in a period, as starting lines for a new
 * statement: the date and a description of the work. The fee is left for KC
 * to enter — what a contractor is paid is not the price the customer paid.
 */
export async function getCompletedJobLines(staffId: string, from: string, to: string) {
  if (!isUuid(staffId)) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("appointments")
    .select("appt_date, customer_name, area_city, appointment_items(description, quantity)")
    .eq("staff_id", staffId)
    .eq("status", "completed")
    .gte("appt_date", from)
    .lte("appt_date", to)
    .order("appt_date")
    .order("start_time");
  type J = { appt_date: string; customer_name: string; area_city: string | null;
    appointment_items: Array<{ description: string; quantity: number }> | null };
  return ((data ?? []) as unknown as J[]).map((j) => {
    const work = (j.appointment_items ?? [])
      .map((i) => (i.quantity > 1 ? `${i.description} x${i.quantity}` : i.description))
      .join(", ");
    const where = [j.customer_name, j.area_city].filter(Boolean).join(", ");
    return {
      date: j.appt_date,
      description: `Cleaning service${work ? ` — ${work}` : ""}${where ? ` (${where})` : ""}`.slice(0, 300),
    };
  });
}
