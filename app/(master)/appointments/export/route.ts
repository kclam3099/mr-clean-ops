import ExcelJS from "exceljs";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope } from "@/lib/workspace/scope";
import { businessToday } from "@/lib/agenda/queries";
import { getCustomerRecords, parseRecordsQuery } from "@/lib/records/queries";

/**
 * The customer records on screen, as a real .xlsx — same filters, same RLS.
 *
 * .xlsx rather than CSV on purpose: a CSV opened in Excel turns 0123456789
 * into 123456789 and treats a cell starting with "=" as a formula. Writing
 * typed cells keeps phone numbers as text and every value as a value.
 */
export async function GET(request: Request) {
  const session = await getSessionContext();
  if (!session?.isMaster) return new Response("Not authorized", { status: 403 });

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams) as { ws?: string; month?: string; staff?: string; q?: string };
  const scope = resolveScope(session, params.ws ?? null);
  const query = parseRecordsQuery(params, businessToday());
  const result = await getCustomerRecords(session, scope, query);
  if (!result.ok) return new Response("Could not load records", { status: 500 });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Records");
  ws.columns = [
    { header: "MONTH", key: "month", width: 8 },
    { header: "DATE", key: "date", width: 12 },
    { header: "AMOUNT", key: "amount", width: 12 },
    { header: "ADD-ON", key: "addon", width: 10 },
    { header: "NAME", key: "name", width: 28 },
    { header: "PHONE NUMBER", key: "phone", width: 16 },
    { header: "ADDRESS", key: "address", width: 70 },
    { header: "STAFF", key: "staff", width: 12 },
    { header: "STATUS", key: "status", width: 11 },
  ];
  ws.getRow(1).font = { bold: true };

  // Oldest first in the file, the way a ledger is kept.
  for (const r of [...result.rows].reverse()) {
    const [y, m, d] = r.date.split("-");
    ws.addRow({
      month: new Date(Date.UTC(Number(y), Number(m) - 1, 1))
        .toLocaleString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase(),
      date: `${d}/${m}/${y}`,
      amount: r.amount,
      addon: r.addons || null,
      name: r.customerName,
      phone: r.phone ?? "",
      address: r.address,
      staff: r.staffName ?? "",
      status: r.status,
    });
  }
  ws.getColumn("amount").numFmt = '"RM"#,##0.00';
  ws.getColumn("addon").numFmt = '"RM"#,##0.00';
  ws.getColumn("phone").numFmt = "@";

  const buffer = await wb.xlsx.writeBuffer();
  const name = `customer-records-${query.month}.xlsx`;
  return new Response(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
