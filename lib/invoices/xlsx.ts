import "server-only";
import JSZip from "jszip";
import { INVOICE_TEMPLATE_BASE64 } from "./template-data";

/**
 * Fills the owner's invoice template and returns the .xlsx bytes.
 *
 * Edits the sheet XML directly instead of loading the workbook into a
 * spreadsheet library: the header is a drawing (logo, the KCRP SOLUTION text
 * box and the gold bar), and libraries that re-serialise the workbook drop text
 * boxes and shapes. Here only the cells below are touched; every other byte of
 * the owner's design is carried through as it is.
 *
 * Layout (from the template):
 *   B2 "Invoice#  MRC0624"   B3 "Date: 3/10/2026"
 *   B5 bill-to name          C5 service / details (merged C5:C7)
 *   B6 address
 *   rows 9–12 items (B description, C amount), row 13 discount (C), row 14 total (C)
 * More than four items: copies of row 11 are inserted before row 12 and
 * everything below moves down, including the item table, merges and notes.
 */

export type InvoiceDoc = {
  invoiceNo: string;
  /** YYYY-MM-DD */
  date: string;
  billToName: string;
  billToAddress: string | null;
  serviceTitle: string | null;
  items: Array<{ description: string; amount: number }>;
  discountLabel: string | null;
  discountAmount: number;
  total: number;
};

const SHEET = "xl/worksheets/sheet1.xml";
const TABLE = "xl/tables/table1.xml";
const TEMPLATE_ITEM_ROWS = 4; // rows 9–12

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "2026-10-03" -> "3/10/2026", the way the owner writes dates. */
export function invoiceDateText(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}/${y}`;
}

/** Shifts every row number >= `from` in a cell ref, range or sqref list. */
function shiftRefs(refs: string, from: number, by: number): string {
  return refs.replace(/([A-Z]+)(\d+)/g, (_, col: string, row: string) => {
    const r = Number(row);
    return `${col}${r >= from ? r + by : r}`;
  });
}

function setCell(sheet: string, ref: string, value: string | number | null): string {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = sheet.match(re);
  if (!m) throw new Error(`invoice template has no cell ${ref}`);
  const style = m[1]?.match(/s="\d+"/)?.[0] ?? "";
  let cell: string;
  if (value === null || value === "") cell = `<c r="${ref}" ${style}/>`;
  else if (typeof value === "number") cell = `<c r="${ref}" ${style}><v>${value}</v></c>`;
  else cell = `<c r="${ref}" ${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  return sheet.replace(m[0], cell);
}

/** Inserts `extra` copies of row 11 before row 12, moving everything below down. */
function insertItemRows(sheet: string, table: string, extra: number): { sheet: string; table: string } {
  if (extra <= 0) return { sheet, table };

  const rows = [...sheet.matchAll(/<row r="(\d+)"[\s\S]*?<\/row>/g)];
  const row11 = rows.find((r) => r[1] === "11")?.[0];
  if (!row11) throw new Error("invoice template has no row 11");

  const renumber = (xml: string, from: number, to: number) =>
    xml.replace(`<row r="${from}"`, `<row r="${to}"`).replace(new RegExp(`r="([A-Z]+)${from}"`, "g"), `r="$1${to}"`);

  let out = sheet;
  // Move rows 12+ down, bottom-up so no two rows ever share a number mid-way.
  for (const r of rows.filter((x) => Number(x[1]) >= 12).sort((a, b) => Number(b[1]) - Number(a[1]))) {
    out = out.replace(r[0], renumber(r[0], Number(r[1]), Number(r[1]) + extra));
  }
  const clones = Array.from({ length: extra }, (_, i) => renumber(row11, 11, 12 + i)).join("");
  out = out.replace(row11, row11 + clones);

  out = out
    .replace(/<dimension ref="([^"]+)"/, (_, ref: string) => `<dimension ref="${shiftRefs(ref, 12, extra)}"`)
    .replace(/<mergeCell ref="([^"]+)"/g, (_, ref: string) => `<mergeCell ref="${shiftRefs(ref, 12, extra)}"`)
    .replace(/sqref="([^"]+)"/g, (_, ref: string) => `sqref="${shiftRefs(ref, 12, extra)}"`);

  const outTable = table.replace(/ref="([^"]+)"/, (_, ref: string) => `ref="${shiftRefs(ref, 12, extra)}"`);
  return { sheet: out, table: outTable };
}

export async function buildInvoiceXlsx(doc: InvoiceDoc): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(Buffer.from(INVOICE_TEMPLATE_BASE64, "base64"));
  let sheet = await zip.file(SHEET)!.async("string");
  let table = await zip.file(TABLE)!.async("string");

  const itemRows = Math.max(TEMPLATE_ITEM_ROWS, doc.items.length);
  const extra = itemRows - TEMPLATE_ITEM_ROWS;
  ({ sheet, table } = insertItemRows(sheet, table, extra));

  sheet = setCell(sheet, "B2", `Invoice#  ${doc.invoiceNo}`);
  sheet = setCell(sheet, "B3", `Date: ${invoiceDateText(doc.date)}`);
  sheet = setCell(sheet, "B5", doc.billToName);
  sheet = setCell(sheet, "B6", doc.billToAddress ?? "");
  sheet = setCell(sheet, "C5", doc.serviceTitle ?? "");

  for (let i = 0; i < itemRows; i++) {
    const item = doc.items[i];
    sheet = setCell(sheet, `B${9 + i}`, item ? item.description : null);
    sheet = setCell(sheet, `C${9 + i}`, item ? item.amount : null);
  }

  const discountRow = 13 + extra;
  const label = doc.discountLabel
    ?? (doc.discountAmount > 0 ? `Discount RM${doc.discountAmount.toFixed(2)}` : null);
  sheet = setCell(sheet, `C${discountRow}`, label);
  sheet = setCell(sheet, `C${14 + extra}`, doc.total);

  zip.file(SHEET, sheet);
  zip.file(TABLE, table);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** "MRC0624 Sharon.xlsx" — the owner's own naming. */
export function invoiceFileName(doc: Pick<InvoiceDoc, "invoiceNo" | "billToName">, ext: "xlsx" | "pdf"): string {
  const name = doc.billToName.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${doc.invoiceNo} ${name}.${ext}`;
}
