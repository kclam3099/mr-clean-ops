// Turn a database snapshot (JSON) into the backup workbook uploaded to the
// owner's Google Drive: one tab of bookings, one of invoices.
//
//   node scripts/build-backup-xlsx.mjs <snapshot.json> <out.xlsx>
//
// The JSON is the result of the snapshot query in docs/DRIVE-BACKUP.md:
//   { "appointments": [...], "invoices": [...] }
// Phone numbers are written as text so their leading 0 survives, and every
// value is a value — nothing a customer typed can become a formula.

import { readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: node scripts/build-backup-xlsx.mjs <snapshot.json> <out.xlsx>");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(input, "utf8"));
const data = raw.data ?? raw;

const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const month = (iso) => (iso
  ? new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, 1)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase()
  : "");
const oneLine = (s) => (s ?? "").replace(/\s*\n\s*/g, " ").trim();

const wb = new ExcelJS.Workbook();
wb.created = new Date();

const appts = wb.addWorksheet("预约 Bookings");
appts.columns = [
  { header: "MONTH", key: "month", width: 7 },
  { header: "INVOICE", key: "invoice", width: 10 },
  { header: "DATE", key: "date", width: 11 },
  { header: "TIME", key: "time", width: 7 },
  { header: "STATUS", key: "status", width: 10 },
  { header: "AMOUNT", key: "amount", width: 10 },
  { header: "ADD-ON", key: "addon", width: 9 },
  { header: "NAME", key: "name", width: 24 },
  { header: "PHONE NUMBER", key: "phone", width: 15 },
  { header: "ADDRESS", key: "address", width: 60 },
  { header: "AREA", key: "area", width: 14 },
  { header: "STAFF", key: "staff", width: 10 },
  { header: "TEAM", key: "team", width: 16 },
  { header: "SERVICES", key: "items", width: 40 },
  { header: "ADD-ONS", key: "addons", width: 30 },
  { header: "REMARKS", key: "remarks", width: 30 },
];
for (const a of data.appointments ?? []) {
  appts.addRow({
    month: month(a.appt_date), invoice: a.invoice_no ?? "", date: dmy(a.appt_date), time: a.start_time ?? "",
    status: a.status, amount: Number(a.total_amount ?? 0), addon: Number(a.addon_total ?? 0) || null,
    name: a.customer_name ?? "", phone: a.customer_phone ?? "", address: oneLine(a.address_line), area: a.area_city ?? "",
    staff: a.staff ?? "", team: a.workspace ?? "", items: a.items ?? "", addons: a.addons ?? "", remarks: oneLine(a.remarks),
  });
}

const invs = wb.addWorksheet("发票 Invoices");
invs.columns = [
  { header: "INVOICE", key: "invoice", width: 10 },
  { header: "INVOICE DATE", key: "date", width: 12 },
  { header: "JOB DATE", key: "jobDate", width: 11 },
  { header: "BILL TO", key: "name", width: 24 },
  { header: "PHONE NUMBER", key: "phone", width: 15 },
  { header: "ADDRESS", key: "address", width: 60 },
  { header: "SERVICE", key: "service", width: 34 },
  { header: "ITEMS", key: "items", width: 40 },
  { header: "DISCOUNT", key: "discountLabel", width: 14 },
  { header: "DISCOUNT RM", key: "discount", width: 11 },
  { header: "TOTAL", key: "total", width: 10 },
  { header: "STAFF", key: "staff", width: 10 },
];
for (const i of data.invoices ?? []) {
  invs.addRow({
    invoice: i.invoice_no, date: dmy(i.invoice_date), jobDate: dmy(i.appt_date), name: i.bill_to_name ?? "",
    phone: i.customer_phone ?? "", address: oneLine(i.bill_to_address), service: i.service_title ?? "", items: i.items ?? "",
    discountLabel: i.discount_label ?? "", discount: Number(i.discount_amount ?? 0) || null, total: Number(i.total ?? 0),
    staff: i.staff ?? "",
  });
}

for (const ws of [appts, invs]) {
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D3D66" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getColumn("phone").numFmt = "@";
}
for (const key of ["amount", "addon"]) appts.getColumn(key).numFmt = '"RM"#,##0';
for (const key of ["discount", "total"]) invs.getColumn(key).numFmt = '"RM"#,##0.##';

writeFileSync(output, Buffer.from(await wb.xlsx.writeBuffer()));
console.log(`${output}: ${(data.appointments ?? []).length} bookings, ${(data.invoices ?? []).length} invoices`);
