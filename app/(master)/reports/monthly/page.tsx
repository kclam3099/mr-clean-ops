import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopeOptions, ALL_OPERATIONS } from "@/lib/workspace/scope";
import { businessToday, monthKey, monthLabel, addMonths } from "@/lib/agenda/queries";
import { getMonthlyReport } from "@/lib/reports/monthly";
import { compactMoney } from "@/lib/pricing/duration";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { StaffReportTable } from "@/components/reports/StaffReportTable";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Monthly report — Mr Clean & Clean Ops" };

/**
 * Monthly report: per staff member, what was booked and what was added on.
 *
 * The add-on column answers the owner's question — "how much did each person
 * add on this month" — and the booked column sits beside it for context, never
 * summed into it. Each person's add-on items open underneath their row, each
 * one linking back to the appointment it was recorded on.
 */
export default async function MonthlyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; month?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const { t, locale } = await getI18n();
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;
  const today = businessToday();
  // A hand-edited or stale month falls back to this one rather than erroring.
  const anchor = /^\d{4}-\d{2}$/.test(params.month ?? "") ? `${params.month}-01` : today;

  const scopeValue = scope.kind === "workspace" ? scope.workspaceId : ALL_OPERATIONS;
  const monthHref = (m: string) => {
    const q = new URLSearchParams();
    if (hasChoice) q.set("ws", scopeValue);
    q.set("month", m);
    return `/reports/monthly?${q.toString()}`;
  };

  const report = await getMonthlyReport(session, scope, anchor);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{t("Monthly report")}</h1>
        <p className="text-sm text-ink-muted" data-scope-label>{t(scope.label)} · {t("Booked work and add-ons")}</p>
      </div>

      <div className="flex items-center gap-1.5">
        <Link href={monthHref(monthKey(today))}
          className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-sunken">
          {t("This month")}
        </Link>
        <Link href={monthHref(monthKey(addMonths(anchor, -1)))} aria-label={t("Previous month")}
          className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink transition hover:bg-sunken">
          <span aria-hidden="true">←</span>
        </Link>
        <Link href={monthHref(monthKey(addMonths(anchor, 1)))} aria-label={t("Next month")}
          className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink transition hover:bg-sunken">
          <span aria-hidden="true">→</span>
        </Link>
        <h2 className="ml-1.5 text-base font-semibold tracking-tight text-ink" data-report-month>
          {monthLabel(anchor, locale)}
        </h2>
      </div>

      {!report.ok ? (
        <ErrorNotice error={report.error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label={t("Jobs")} value={String(report.totals.jobs)} />
            <Tile label={t("Booked")} value={compactMoney(report.totals.booked)} />
            <Tile label={t("Add-ons")} value={String(report.totals.addonCount)} />
            <Tile label={t("Add-on amount")} value={compactMoney(report.totals.addonAmount)} accent />
          </div>

          {!report.addonsAvailable ? (
            <p className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
              {t("Add-on tracking is not switched on yet. Booked figures below are complete.")}
            </p>
          ) : null}

          {report.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-faint">
              {t("Nothing booked or added on in {month}.", { month: monthLabel(anchor, locale) })}
            </p>
          ) : (
            <StaffReportTable rows={report.rows} totals={report.totals} />
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${accent ? "border-gold bg-amber/15" : "border-line bg-card"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${accent ? "text-brand" : "text-ink"}`}>{value}</p>
    </div>
  );
}
