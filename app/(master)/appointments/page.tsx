import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope, scopeOptions, ALL_OPERATIONS } from "@/lib/workspace/scope";
import { businessToday, addMonths, monthLabel } from "@/lib/agenda/queries";
import { getCalendarStaff } from "@/lib/agenda/staff";
import { getCustomerRecords, parseRecordsQuery } from "@/lib/records/queries";
import { compactMoney } from "@/lib/pricing/duration";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { RecordsTable } from "@/components/records/RecordsTable";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Customer records — Mr Clean & Clean Ops" };

/**
 * Customer records — every job as one row, the database version of the
 * owner's Google Sheet: month, date, amount, add-ons, name, phone, address,
 * and who did it. Filter by month, staff and a search over name / phone /
 * address; export what is on screen as a spreadsheet.
 *
 * Replaces the "next 30 days" agenda that lived here: the calendar already
 * answers "what is coming up". Rows link to the appointment for anything
 * beyond the record itself.
 */
export default async function CustomerRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; month?: string; staff?: string; q?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  const { t, locale } = await getI18n();

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const hasChoice = scopeOptions(session).length >= 2;
  const scopeValue = scope.kind === "workspace" ? scope.workspaceId : ALL_OPERATIONS;
  const today = businessToday();
  const query = parseRecordsQuery(params, today);

  const [result, roster] = await Promise.all([
    getCustomerRecords(session, scope, query),
    getCalendarStaff(session, scope),
  ]);

  const href = (over: Record<string, string | null>) => {
    const q = new URLSearchParams();
    if (hasChoice) q.set("ws", scopeValue);
    const merged = { month: query.month, staff: query.staffId, q: query.search || null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    return `?${q.toString()}`;
  };
  const isAll = query.month === "all";
  const anchor = isAll ? `${today.slice(0, 7)}-01` : `${query.month}-01`;
  const exportHref = `/appointments/export${href({})}`;

  const rows = result.ok ? result.rows : [];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const addons = rows.reduce((s, r) => s + r.addons, 0);
  const showWorkspace = scope.kind === "all" && session.workspaces.length > 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">{t("Customer records")}</h1>
          <p className="text-sm text-ink-muted">
            {t(scope.label)} · {isAll ? t("All months") : monthLabel(anchor, locale)}
          </p>
        </div>
        <a href={exportHref} data-records-export
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-ink transition hover:bg-sunken">
          {t("Download spreadsheet")}
        </a>
      </div>

      {/* Month navigation */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={href({ month: today.slice(0, 7) })}
          className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-sunken">
          {t("This month")}
        </Link>
        <Link href={href({ month: addMonths(anchor, -1).slice(0, 7) })} aria-label={t("Previous month")}
          className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink transition hover:bg-sunken">
          <span aria-hidden="true">←</span>
        </Link>
        <Link href={href({ month: addMonths(anchor, 1).slice(0, 7) })} aria-label={t("Next month")}
          className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink transition hover:bg-sunken">
          <span aria-hidden="true">→</span>
        </Link>
        <Link href={href({ month: "all" })} data-active={isAll ? "true" : undefined}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            isAll ? "border-brand bg-brand text-white" : "border-line bg-card text-ink hover:bg-sunken"}`}>
          {t("All months")}
        </Link>
      </div>

      {/* Staff + search. A plain GET form: the filters live in the URL, so a
          filtered view can be bookmarked or sent to someone. */}
      <form method="get" className="flex flex-wrap items-end gap-2" data-records-filter>
        {hasChoice ? <input type="hidden" name="ws" value={scopeValue} /> : null}
        <input type="hidden" name="month" value={query.month} />
        <label className="text-sm font-medium text-ink">
          <span className="mb-1 block text-xs text-ink-muted">{t("Staff")}</span>
          <select name="staff" defaultValue={query.staffId ?? ""}
            className="min-h-10 rounded-lg border border-line bg-card px-3 text-sm text-ink">
            <option value="">{t("Everyone")}</option>
            {roster.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="min-w-[12rem] flex-1 text-sm font-medium text-ink">
          <span className="mb-1 block text-xs text-ink-muted">{t("Search")}</span>
          <input type="search" name="q" defaultValue={query.search}
            placeholder={t("Name, phone or address")}
            className="min-h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink" />
        </label>
        <button type="submit"
          className="min-h-10 cursor-pointer rounded-lg bg-brand px-4 text-sm font-semibold text-white transition hover:bg-brand-700">
          {t("Filter")}
        </button>
        {query.staffId || query.search ? (
          <Link href={href({ staff: null, q: null })} className="min-h-10 px-2 py-2 text-sm text-ink-muted hover:text-ink">
            {t("Clear")}
          </Link>
        ) : null}
      </form>

      {!result.ok ? <ErrorNotice error={result.error} /> : null}

      {result.ok ? (
        <p className="text-xs text-ink-muted" data-records-summary>
          {rows.length === 1 ? t("1 job") : t("{count} jobs", { count: rows.length })}
          {" · "}<span className="tabular-nums">{compactMoney(total)}</span>
          {addons > 0 ? <> {" · "}{t("Add-ons")} <span className="tabular-nums">{compactMoney(addons)}</span></> : null}
        </p>
      ) : null}

      {result.ok && rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-faint">
          {t("No records match.")}
        </p>
      ) : null}

      {rows.length > 0 ? <RecordsTable rows={rows} showWorkspace={showWorkspace} /> : null}
    </div>
  );
}

