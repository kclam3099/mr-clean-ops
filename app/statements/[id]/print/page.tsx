import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getStatement } from "@/lib/statements/queries";
import { StatementDocument } from "@/components/statements/StatementDocument";
import { PrintButton } from "@/components/invoices/PrintButton";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const s = await getStatement((await params).id);
  // Becomes the suggested PDF file name.
  return { title: s ? `${s.statementNo} ${s.contractorName}` : "Statement" };
}

/** The statement as a printable A4 page — KC only, like everything about statements. */
export default async function StatementPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.isSuperMaster) notFound();
  const statement = await getStatement((await params).id);
  if (!statement) notFound();

  return (
    <div className="min-h-screen bg-white text-[#2B3440] print:min-h-0 print:bg-white">
      {/* A4 with no page margin, so the browser prints no date / URL header. */}
      <style>{"@page { size: A4; margin: 0; } @media print { html, body { background: #fff !important; } }"}</style>
      <div className="mx-auto flex max-w-[52rem] justify-end gap-2 px-4 pt-4 print:hidden">
        <PrintButton />
      </div>
      <StatementDocument statement={statement} />
    </div>
  );
}
