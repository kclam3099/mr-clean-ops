import Link from "next/link";
import type { MonthlyReport, StaffMonthRow } from "@/lib/reports/monthly";
import { colourAt, staffBadgeLetter } from "@/lib/agenda/staff-colour";
import { compactMoney } from "@/lib/pricing/duration";
import { getI18n } from "@/lib/i18n/server";

type Totals = Extract<MonthlyReport, { ok: true }>["totals"];

/**
 * One row per staff member: jobs and booked amount for context, then the
 * add-on count and amount. Each row opens to the add-on items behind it, each
 * linking to its appointment. Native <details>, so it needs no client script.
 */
export async function StaffReportTable({ rows, totals }: { rows: StaffMonthRow[]; totals: Totals }) {
  const { t, locale } = await getI18n();
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card" data-report-staff>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 bg-brand px-4 py-2 text-[11px] font-bold
                      uppercase tracking-wider text-white/85 sm:grid-cols-[1fr_4rem_7rem_5rem_8rem]">
        <span>{t("Staff")}</span>
        <span className="hidden text-right sm:block">{t("Jobs")}</span>
        <span className="hidden text-right sm:block">{t("Booked")}</span>
        <span className="text-right">{t("Add-ons")}</span>
        <span className="text-right">{t("Add-on RM")}</span>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.staffId} data-report-row={r.staffId}>
            <details className="group">
              <summary
                className={`grid cursor-pointer list-none grid-cols-[1fr_auto_auto] items-center gap-x-4 px-4 py-3
                            text-sm hover:bg-sunken sm:grid-cols-[1fr_4rem_7rem_5rem_8rem]
                            [&::-webkit-details-marker]:hidden`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                                                text-[11px] font-bold text-white ${colourAt(r.colourIndex).solid}`}>
                    {staffBadgeLetter(r.staffName)}
                  </span>
                  <span className="min-w-0">
                    <span className={`block truncate font-semibold ${colourAt(r.colourIndex).text}`}>{r.staffName}</span>
                    {/* Below sm the jobs/booked columns fold into a subline. */}
                    <span className="block text-xs text-ink-muted sm:hidden">
                      {r.jobs === 1
                        ? t("{count} job · {amount} booked", { count: r.jobs, amount: compactMoney(r.booked) })
                        : t("{count} jobs · {amount} booked", { count: r.jobs, amount: compactMoney(r.booked) })}
                    </span>
                  </span>
                  {r.addonCount > 0 ? (
                    <span aria-hidden className="shrink-0 text-base leading-none text-ink-faint transition group-open:rotate-90">›</span>
                  ) : null}
                </span>
                <span className="hidden text-right tabular-nums text-ink sm:block">{r.jobs}</span>
                <span className="hidden text-right tabular-nums text-ink sm:block">{compactMoney(r.booked)}</span>
                <span className="text-right tabular-nums text-ink">{r.addonCount}</span>
                <span className={`text-right font-bold tabular-nums ${r.addonAmount > 0 ? "text-brand" : "text-ink-faint"}`}>
                  {compactMoney(r.addonAmount)}
                </span>
              </summary>
              {r.addons.length > 0 ? (
                <ul className="divide-y divide-line/60 border-t border-line bg-sunken/60">
                  {r.addons.map((a) => (
                    <li key={a.id}>
                      <Link href={`/appointments/${a.appointmentId}`}
                        className="flex items-baseline justify-between gap-3 px-4 py-2 pl-12 text-xs hover:bg-brand/5">
                        <span className="min-w-0">
                          <span className="tabular-nums text-ink-muted">{shortDate(a.date, locale)}</span>
                          <span className="mx-1.5 text-ink-faint">·</span>
                          <span className="font-medium text-ink">{a.description}</span>
                          <span className="block truncate text-ink-faint sm:inline sm:before:mx-1.5 sm:before:content-['·']">
                            {a.customerName}
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-ink">{compactMoney(a.amount)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-t-2 border-gold bg-sunken px-4 py-3 text-sm
                      font-bold sm:grid-cols-[1fr_4rem_7rem_5rem_8rem]">
        <span className="text-ink">{t("Total")}</span>
        <span className="hidden text-right tabular-nums text-ink sm:block">{totals.jobs}</span>
        <span className="hidden text-right tabular-nums text-ink sm:block">{compactMoney(totals.booked)}</span>
        <span className="text-right tabular-nums text-ink">{totals.addonCount}</span>
        <span className="text-right tabular-nums text-brand">{compactMoney(totals.addonAmount)}</span>
      </div>
    </section>
  );
}

function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}
