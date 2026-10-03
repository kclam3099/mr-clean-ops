import Link from "next/link";
import type { RecordRow } from "@/lib/records/queries";
import { colourAt } from "@/lib/agenda/staff-colour";
import { compactMoney } from "@/lib/pricing/duration";
import { getI18n } from "@/lib/i18n/server";

/** The records as a spreadsheet on a wide screen, compact rows on a phone. */
export async function RecordsTable({ rows, showWorkspace }: { rows: RecordRow[]; showWorkspace: boolean }) {
  const { t, locale } = await getI18n();
  return (
    <>
    {/* ---- desktop / tablet: the spreadsheet ---- */}
    <div className="hidden overflow-x-auto rounded-xl border border-line bg-card md:block" data-records-table>
      <table className="w-full text-left text-sm">
        <thead className="bg-brand text-[11px] font-bold uppercase tracking-wider text-white/85">
          <tr>
            <th className="px-3 py-2">{t("Date")}</th>
            <th className="px-3 py-2">{t("Invoice")}</th>
            <th className="px-3 py-2 text-right">{t("Amount")}</th>
            <th className="px-3 py-2 text-right">{t("Add-on")}</th>
            <th className="px-3 py-2">{t("Name")}</th>
            <th className="px-3 py-2">{t("Phone")}</th>
            <th className="px-3 py-2">{t("Address")}</th>
            <th className="px-3 py-2">{t("Staff")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id} data-record-row={r.id} className="align-top hover:bg-sunken/60">
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                <Link href={`/appointments/${r.id}`} className="font-medium text-brand hover:underline">
                  {shortDate(r.date, locale)}
                </Link>
                {r.status === "completed" ? <span className="ml-1 text-[10px] text-ok">✓</span> : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {r.invoiceId ? (
                  <a href={`/invoices/${r.invoiceId}/print`} target="_blank" rel="noopener"
                    className="font-medium text-ink hover:text-brand hover:underline">{r.invoiceNo}</a>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{compactMoney(r.amount)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-ink-muted">
                {r.addons > 0 ? compactMoney(r.addons) : ""}
              </td>
              <td className="px-3 py-2 font-medium text-ink">{r.customerName}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {r.phone ? <a href={`tel:${r.phone}`} className="hover:text-brand">{r.phone}</a> : ""}
              </td>
              <td className="min-w-[16rem] px-3 py-2 text-ink-muted">{r.address}</td>
              <td className="whitespace-nowrap px-3 py-2">
                {r.staffName ? (
                  <span className={`font-medium ${colourAt(r.staffColourIndex).text}`}>{r.staffName}</span>
                ) : null}
                {showWorkspace && r.workspaceName ? (
                  <span className="block text-[11px] text-ink-faint">{r.workspaceName}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {/* ---- phone: one compact row per job ---- */}
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card md:hidden">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/appointments/${r.id}`} className="block px-3 py-2.5 hover:bg-sunken/60">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate font-semibold text-ink">{r.customerName}</span>
              <span className="shrink-0 font-semibold tabular-nums text-ink">
                {compactMoney(r.amount)}
                {r.addons > 0 ? <span className="ml-1 text-xs font-normal text-ink-muted">+{compactMoney(r.addons)}</span> : null}
              </span>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted">
              <span className="tabular-nums">{shortDate(r.date, locale)}</span>
              {r.invoiceNo ? <><span aria-hidden>·</span><span className="font-medium tabular-nums text-ink">{r.invoiceNo}</span></> : null}
              {r.staffName ? <><span aria-hidden>·</span><span className={colourAt(r.staffColourIndex).text}>{r.staffName}</span></> : null}
              {r.phone ? <><span aria-hidden>·</span><span className="tabular-nums">{r.phone}</span></> : null}
            </span>
            {r.address ? <span className="mt-0.5 block truncate text-xs text-ink-faint">{r.address}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  </>
  );
}

function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}
