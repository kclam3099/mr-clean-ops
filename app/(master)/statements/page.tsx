import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { businessToday } from "@/lib/agenda/queries";
import { getContractors, getStatements } from "@/lib/statements/queries";
import { ContractorProfiles } from "@/components/statements/ContractorProfiles";
import { invoiceMoney } from "@/lib/invoices/money";
import { dmy } from "@/lib/statements/types";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Contractor statements — Mr Clean & Clean Ops" };

/**
 * Statements of Services Rendered — KC only. A non-Super-Master gets the same
 * 404 as for a page that does not exist; the data is RLS-locked as well (0022).
 */
export default async function StatementsPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.isSuperMaster) notFound();
  const { t } = await getI18n();

  const [contractors, statements] = await Promise.all([getContractors(), getStatements()]);
  const thisMonth = businessToday().slice(0, 7);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{t("Contractor statements")}</h1>
        <p className="text-sm text-ink-muted">
          {t("Statement of Services Rendered — payment statements for independent contractors. Only KC can see this page.")}
        </p>
      </div>

      <form method="get" action="/statements/new" className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-card p-4" data-new-statement>
        <label className="text-sm font-medium text-ink">
          <span className="mb-1 block text-xs text-ink-muted">{t("Contractor")}</span>
          <select name="staff" className="min-h-10 rounded-lg border border-line bg-card px-3 text-sm">
            {contractors.map((c) => <option key={c.staffId} value={c.staffId}>{c.displayName}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-ink">
          <span className="mb-1 block text-xs text-ink-muted">{t("Month of service")}</span>
          <input type="month" name="month" defaultValue={thisMonth} className="min-h-10 rounded-lg border border-line bg-card px-3 text-sm" />
        </label>
        <button type="submit" className="min-h-10 cursor-pointer rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-700">
          {t("New statement")}
        </button>
      </form>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">{t("Issued statements")}</h2>
        {statements.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">{t("No statements yet.")}</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {statements.map((s) => (
              <li key={s.id}>
                <Link href={`/statements/${s.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-sunken/60">
                  <span className="min-w-0">
                    <span className="font-semibold text-ink">{s.statementNo}</span>
                    <span className="ml-2 text-sm text-ink-muted">{s.contractorName}</span>
                    <span className="block text-xs text-ink-faint">
                      {dmy(s.issueDate)}{s.periodFrom ? ` · ${dmy(s.periodFrom)} – ${dmy(s.periodTo)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-bold tabular-nums text-brand">{invoiceMoney(s.netAmount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">{t("Contractor details")}</h2>
        <ContractorProfiles rows={contractors} />
      </section>
    </div>
  );
}
