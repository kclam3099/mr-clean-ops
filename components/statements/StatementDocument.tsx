import Image from "next/image";
import { invoiceMoney } from "@/lib/invoices/money";
import { dmy, RECEIPT_ACKNOWLEDGEMENT, type StatementDoc } from "@/lib/statements/types";

/**
 * Statement of Services Rendered — the contractor's payment statement.
 *
 * Built on the invoice's exact structure (InvoiceDocument): the same header
 * (logo | gold bar | KCRP SOLUTION as the payer), the same navy title rule and
 * right-hand label box, the same two-column info bands, the same navy grid and
 * navy total bar with the gold rule. What changes is what it says: this is
 * money going OUT to an independent contractor, so the title sits where
 * "Invoice# …" sits, the payee replaces BILL TO, and the page ends with the
 * contractor's signed acknowledgement of receipt.
 *
 * Pure presentation; the caller has read the statement through RLS (KC only).
 */
export function StatementDocument({ statement: s }: { statement: StatementDoc }) {
  const money = invoiceMoney;
  const rows = [...s.lines, ...Array.from({ length: Math.max(0, 4 - s.lines.length) }, () => null)];
  const period = s.periodFrom || s.periodTo ? `${dmy(s.periodFrom)} – ${dmy(s.periodTo)}` : null;

  return (
    <article
      className="mx-auto max-w-[52rem] px-6 py-8 text-[13px] leading-snug sm:px-12 print:max-w-none print:px-[14mm] print:py-[10mm]"
      // Print the navy / tinted backgrounds — browsers drop them otherwise.
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
      data-statement-doc
    >
      {/* Header: logo | gold bar | payer — identical to the invoice */}
      <header className="flex items-center gap-6">
        <Image src="/brand/invoice-logo.png" alt="Mr Clean & Clean" width={150} height={150} className="h-28 w-28 object-contain" priority />
        <div className="h-24 w-1.5 shrink-0 rounded bg-[#F2AC00]" />
        <div>
          <p className="text-2xl font-bold text-[#0D3D66]">KCRP SOLUTION</p>
          <p className="text-xs font-bold text-[#B87700]">(003072052-P)</p>
          <p className="mt-0.5 text-[#3D4856]">NO. 11-1, Jalan 3/33A, (Jalan Ambong 2),</p>
          <p className="text-[#3D4856]">Kepong, Malaysia&nbsp; | &nbsp;013 780 2344</p>
        </div>
      </header>

      {/* Title where "Invoice# …" sits; the label box where "INVOICE" sits */}
      <div className="mt-6 grid grid-cols-[2fr_1fr] border-t-4 border-[#0D3D66]">
        <h1 className="py-3 pl-1 text-[1.6rem] font-bold leading-tight text-[#0D3D66]">Statement of Services Rendered</h1>
        <div className="flex items-center justify-center bg-[#0D3D66] px-2 text-center text-sm font-bold text-white">
          PAYMENT STATEMENT
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-6 pl-1 text-xs text-[#667085]">
        <p>
          Statement No: <span className="font-bold text-[#0D3D66]">{s.statementNo}</span>
          <span className="mx-2">·</span>
          Date of Issue: <span className="text-[#2B3440]">{dmy(s.issueDate)}</span>
        </p>
        {period ? <p>Service Period: <span className="text-[#2B3440]">{period}</span></p> : null}
      </div>

      {/* Payee (contractor) | Payer — the BILL TO / SERVICE bands */}
      <div className="mt-1 grid grid-cols-[2fr_1fr]">
        <div className="border-l-2 border-[#0D3D66]">
          <p className="bg-[#E9EFF7] px-2 py-2.5 text-xs font-bold text-[#0D3D66]">CONTRACTOR (PAYEE)</p>
          <div className="space-y-1 bg-[#F7F9FC] px-2 py-3">
            <p className="font-bold text-[#2B3440]">{s.contractorName}</p>
            <p><span className="text-[#667085]">IC / Passport No:</span> {s.contractorIdNumber ?? "—"}</p>
            <p><span className="text-[#667085]">Contact:</span> {s.contractorContact ?? "—"}</p>
          </div>
        </div>
        <div className="border-l-2 border-[#0D3D66]">
          <p className="bg-[#E9EFF7] px-2 py-2.5 text-xs font-bold text-[#0D3D66]">PAYER</p>
          <div className="space-y-1 bg-[#F7F9FC] px-2 py-3">
            <p className="font-bold text-[#2B3440]">KCRP SOLUTION</p>
            <p className="text-[#3D4856]">(003072052-P)</p>
            <p className="text-[#3D4856]">Independent contractor services</p>
          </div>
        </div>
      </div>

      {/* Service description grid */}
      <table className="mt-3 w-full border-collapse border-2 border-[#0D3D66]">
        <thead>
          <tr className="bg-[#0D3D66] text-white">
            <th className="w-[18%] py-2.5 text-center text-sm font-bold">Date of Service</th>
            <th className="py-2.5 text-center text-sm font-bold">Description of Cleaning Work</th>
            <th className="w-[24%] py-2.5 text-center text-sm font-bold">Gross Service Fee</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((line, i) => (
            <tr key={i} className={i % 2 ? "bg-[#F7F9FC]" : "bg-white"}>
              <td className="h-9 border-b border-[#C9D4E3] text-center tabular-nums">{line ? dmy(line.date) : ""}</td>
              <td className="h-9 border-b border-l border-[#C9D4E3] px-4">{line?.description ?? ""}</td>
              <td className="h-9 border-b border-l border-[#C9D4E3] text-center tabular-nums">{line ? money(line.amount) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Financial summary: gross, deductions (the invoice's cream discount row), net bar */}
      <div className="grid grid-cols-[1fr_24%] border-x-2 border-[#0D3D66] bg-white text-sm">
        <p className="border-b border-[#C9D4E3] py-2 pr-6 text-right font-bold text-[#0D3D66]">TOTAL GROSS FEE</p>
        <p className="border-b border-l border-[#C9D4E3] py-2 text-center font-bold tabular-nums">{money(s.grossTotal)}</p>
      </div>
      {(s.deductions.length ? s.deductions : [{ label: "Deductions", amount: 0 }]).map((d, i) => (
        <div key={i} className="grid grid-cols-[1fr_24%] border-x-2 border-[#0D3D66] bg-[#FFF6E0] text-sm">
          <p className="border-b border-[#C9D4E3] py-2 pr-6 text-right font-bold text-[#915C00]">
            {s.deductions.length ? `Less: ${d.label}` : "DEDUCTIONS"}
          </p>
          <p className="border-b border-l border-[#C9D4E3] py-2 text-center font-bold tabular-nums text-[#915C00]">
            {d.amount > 0 ? `− ${money(d.amount)}` : "—"}
          </p>
        </div>
      ))}
      <div className="grid grid-cols-[1fr_24%] border-b-4 border-[#F2AC00] bg-[#0D3D66] text-white">
        <p className="py-3 pr-6 text-right text-sm font-bold">NET AMOUNT PAID</p>
        <p className="py-3 text-center text-base font-bold tabular-nums">{money(s.netAmount)}</p>
      </div>

      {/* Payment reference — the PAYMENT METHOD / BANK ACCOUNT band */}
      <div className="mt-5 grid grid-cols-[2fr_1fr] gap-4 bg-[#F7F9FC] px-4 py-4 text-xs">
        <div>
          <p className="font-bold text-[#0D3D66]">PAYMENT METHOD</p>
          <p className="mt-1 text-[#3D4856]">{s.paymentMethod ?? "—"}</p>
          <p className="mt-2 font-bold text-[#0D3D66]">PAID FROM</p>
          <p className="mt-1 text-[#3D4856]">PUBLIC BANK 3215930024 · KCRP SOLUTION</p>
        </div>
        <div>
          <p className="font-bold text-[#0D3D66]">PAYMENT REFERENCE</p>
          <p className="mt-1 break-words text-[#3D4856]">{s.paymentReference ?? "—"}</p>
          <p className="mt-2 font-bold text-[#0D3D66]">PAYMENT DATE</p>
          <p className="mt-1 text-[#3D4856]">{dmy(s.paymentDate) || "—"}</p>
        </div>
      </div>

      {/* Sign-off — the PAYMENT INSTRUCTIONS band */}
      <div className="mt-3 bg-[#F4F6FA] px-4 py-5 text-[12px] text-[#444F5C]">
        <p className="font-bold text-[#0D3D66]">RECEIPT ACKNOWLEDGEMENT</p>
        <p className="mt-1">{RECEIPT_ACKNOWLEDGEMENT}</p>
        <div className="mt-10 grid grid-cols-[2fr_1fr] gap-10">
          <div>
            <div className="border-b border-[#2B3440]" />
            <p className="mt-1 text-[11px]">Signature of Contractor</p>
            <p className="text-[11px] font-bold text-[#2B3440]">{s.contractorName}</p>
          </div>
          <div>
            <div className="border-b border-[#2B3440]" />
            <p className="mt-1 text-[11px]">Date</p>
          </div>
        </div>
      </div>
    </article>
  );
}
