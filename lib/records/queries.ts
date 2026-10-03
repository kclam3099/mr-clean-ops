import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import { getMasterAgenda, monthRange, businessToday, addDays, type DateRange } from "@/lib/agenda/queries";
import type { AppError } from "@/lib/errors/appError";
import { getInvoiceNumbers } from "@/lib/invoices/queries";

/**
 * Customer records: every job as one row — the database version of the owner's
 * Google Sheet (MONTH · DATE · AMOUNT · Add · NAME · PHONE · ADDRESS).
 *
 * Built on getMasterAgenda, so it is RLS-filtered exactly like the calendar: a
 * Shared-Team-only Master's records are Shared-Team records, and cancelled
 * jobs are not records of work. Add-ons are summed from their own table through
 * the same visibility rule.
 */

export type RecordRow = {
  id: string;
  date: string;
  startTime: string;
  customerName: string;
  phone: string | null;
  address: string;
  amount: number;
  addons: number;
  staffId: string | null;
  staffName: string | null;
  staffColourIndex: number;
  workspaceName: string | null;
  status: "booked" | "completed" | "cancelled";
  /** MRC number and invoice id once invoiced (0018). */
  invoiceNo: string | null;
  invoiceId: string | null;
};

export type RecordsQuery = {
  /** "YYYY-MM", or "all" for the last two years and anything booked ahead. */
  month: string;
  staffId: string | null;
  search: string;
};

export type RecordsResult =
  | { ok: true; rows: RecordRow[]; range: DateRange }
  | { ok: false; error: AppError };

export function recordsRange(month: string): DateRange {
  if (month === "all") {
    const today = businessToday();
    return { from: addDays(today, -730), to: addDays(today, 365) };
  }
  return monthRange(`${month}-01`);
}

export async function getCustomerRecords(
  session: SessionContext,
  scope: WorkspaceScope,
  query: RecordsQuery,
): Promise<RecordsResult> {
  const range = recordsRange(query.month);
  const agenda = await getMasterAgenda(session, scope, range);
  if (!agenda.ok) return { ok: false, error: agenda.error };

  // Newest first, like a ledger read from the top.
  let appts = [...agenda.appointments].sort((a, b) =>
    a.date === b.date ? b.startTime.localeCompare(a.startTime) : b.date.localeCompare(a.date));
  if (query.staffId) appts = appts.filter((a) => a.staffId === query.staffId);

  const q = query.search.trim().toLowerCase();
  if (q) {
    const digits = q.replace(/\D/g, "");
    appts = appts.filter((a) =>
      a.customerName.toLowerCase().includes(q)
      || (a.addressLine ?? "").toLowerCase().includes(q)
      || (a.areaCity ?? "").toLowerCase().includes(q)
      || (digits.length >= 3 && (a.customerPhone ?? "").replace(/\D/g, "").includes(digits)));
  }

  // Add-on totals per appointment. A failed read (e.g. no 0013 yet) shows 0
  // rather than hiding the ledger.
  const addonByAppt = new Map<string, number>();
  if (appts.length > 0) {
    const supabase = await createClient();
    const ids = appts.map((a) => a.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase
        .from("appointment_addons")
        .select("appointment_id, amount")
        .in("appointment_id", ids.slice(i, i + 200));
      for (const r of (data ?? []) as Array<{ appointment_id: string; amount: string | number }>) {
        addonByAppt.set(r.appointment_id, (addonByAppt.get(r.appointment_id) ?? 0) + Number(r.amount));
      }
    }
  }

  const invoices = await getInvoiceNumbers(appts.map((a) => a.id));

  return {
    ok: true,
    range,
    rows: appts.map((a) => ({
      id: a.id,
      date: a.date,
      startTime: a.startTime,
      customerName: a.customerName,
      phone: a.customerPhone,
      address: [a.addressLine, a.areaCity].filter(Boolean).join(", "),
      amount: a.totalAmount ?? 0,
      addons: addonByAppt.get(a.id) ?? 0,
      staffId: a.staffId,
      staffName: a.staffName,
      staffColourIndex: a.staffColourIndex,
      workspaceName: a.workspaceName,
      status: a.status,
      invoiceNo: invoices.get(a.id)?.no ?? null,
      invoiceId: invoices.get(a.id)?.id ?? null,
    })),
  };
}

/** Reads the hand-editable URL parameters; anything odd falls back. */
export function parseRecordsQuery(
  params: { month?: string; staff?: string; q?: string },
  today: string,
): RecordsQuery {
  const month = params.month === "all" || /^\d{4}-\d{2}$/.test(params.month ?? "")
    ? (params.month as string)
    : today.slice(0, 7);
  const staffId = /^[0-9a-f-]{36}$/i.test(params.staff ?? "") ? (params.staff as string) : null;
  return { month, staffId, search: (params.q ?? "").slice(0, 100) };
}
