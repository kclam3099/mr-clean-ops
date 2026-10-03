import Image from "next/image";
import type { InvoiceDoc } from "@/lib/invoices/xlsx";
import { invoiceDateText } from "@/lib/invoices/xlsx";

/**
 * The invoice drawn as HTML in the owner's Excel design, for printing / saving
 * as PDF. Pure presentation: the caller has already read the invoice through RLS.
 */
export function InvoiceDocument({ invoice }: { invoice: InvoiceDoc }) {
  const money = (n: number) => `RM${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = [...invoice.items, ...Array.from({ length: Math.max(0, 4 - invoice.items.length) }, () => null)];
  const discount = invoice.discountLabel ?? (invoice.discountAmount > 0 ? `Discount ${money(invoice.discountAmount)}` : "");

  return (
  <article className="mx-auto max-w-[52rem] px-6 py-8 text-[13px] leading-snug sm:px-12" data-invoice-doc>
    {/* Header: logo | gold bar | company */}
    <header className="flex items-center gap-6">
      <Image src="/brand/invoice-logo.png" alt="Mr Clean & Clean" width={150} height={150} className="h-32 w-32 object-contain" priority />
      <div className="h-28 w-1.5 shrink-0 rounded bg-[#F2AC00]" />
      <div>
        <p className="text-2xl font-bold text-[#0D3D66]">KCRP SOLUTION</p>
        <p className="text-xs font-bold text-[#B87700]">(003072052-P)</p>
        <p className="mt-0.5 text-[#3D4856]">NO. 11-1, Jalan 3/33A, (Jalan Ambong 2),</p>
        <p className="text-[#3D4856]">Kepong, Malaysia&nbsp; | &nbsp;013 780 2344</p>
      </div>
    </header>

    <div className="mt-8 grid grid-cols-[2fr_1fr] border-t-4 border-[#0D3D66]">
      <h1 className="py-3 pl-1 text-3xl font-bold text-[#0D3D66]">Invoice#&nbsp; {invoice.invoiceNo}</h1>
      <div className="flex items-center justify-center bg-[#0D3D66] text-sm font-bold text-white">INVOICE</div>
    </div>
    <p className="mt-2 pl-1 text-xs text-[#667085]">Date: {invoiceDateText(invoice.date)}</p>

    <div className="mt-1 grid grid-cols-[2fr_1fr]">
      <div className="border-l-2 border-[#0D3D66]">
        <p className="bg-[#E9EFF7] px-2 py-2.5 text-xs font-bold text-[#0D3D66]">BILL TO</p>
        <div className="space-y-3 bg-[#F7F9FC] px-2 py-3">
          <p className="font-bold text-[#2B3440]">{invoice.billToName}</p>
          {invoice.billToAddress ? <p className="whitespace-pre-line">{invoice.billToAddress}</p> : null}
        </div>
      </div>
      <div className="border-l-2 border-[#0D3D66]">
        <p className="bg-[#E9EFF7] px-2 py-2.5 text-xs font-bold text-[#0D3D66]">SERVICE / DETAILS</p>
        <div className="flex h-[calc(100%-2.25rem)] items-center bg-[#F7F9FC] px-2 py-3">
          <p>{invoice.serviceTitle ?? ""}</p>
        </div>
      </div>
    </div>

    <table className="mt-3 w-full border-collapse border-2 border-[#0D3D66]">
      <thead>
        <tr className="bg-[#0D3D66] text-white">
          <th className="w-2/3 py-2.5 text-center text-sm font-bold">Item Description</th>
          <th className="py-2.5 text-center text-sm font-bold">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item, i) => (
          <tr key={i} className={i % 2 ? "bg-[#F7F9FC]" : "bg-white"}>
            <td className="h-10 border-b border-[#C9D4E3] px-7">{item?.description ?? ""}</td>
            <td className="h-10 border-b border-l border-[#C9D4E3] text-center tabular-nums">{item ? money(item.amount) : ""}</td>
          </tr>
        ))}
        <tr className="bg-[#FFF6E0]">
          <td className="h-9" />
          <td className="h-9 border-l border-[#C9D4E3] text-center font-bold text-[#915C00]">{discount}</td>
        </tr>
      </tbody>
    </table>
    <div className="grid grid-cols-[2fr_1fr] border-b-4 border-[#F2AC00] bg-[#0D3D66] text-white">
      <p className="py-3 pr-6 text-right text-sm font-bold">TOTAL</p>
      <p className="py-3 text-center text-base font-bold tabular-nums">{money(invoice.total)}</p>
    </div>

    <div className="mt-5 grid grid-cols-[2fr_1fr] bg-[#F7F9FC] px-4 py-5 text-xs">
      <div>
        <p className="font-bold text-[#0D3D66]">PAYMENT METHOD</p>
        <p className="mt-1 text-[#3D4856]">Bank Transfer / Cheque / QR Code</p>
      </div>
      <div>
        <p className="font-bold text-[#0D3D66]">BANK ACCOUNT</p>
        <p className="mt-1 text-[#3D4856]">PUBLIC BANK 3215930024</p>
        <p className="text-[#3D4856]">KCRP SOLUTION</p>
      </div>
    </div>
    <div className="mt-3 bg-[#F4F6FA] px-4 py-5 text-[11px] text-[#444F5C]">
      <p className="font-bold text-[#0D3D66]">PAYMENT INSTRUCTIONS</p>
      <p className="mt-1">1. Bank Draft or Cheque (crossed “Account Payee only”) addressed to KCRP SOLUTION. (Account ID and Company Name must be stated on the reverse portion of your Bank Draft / Cheque)</p>
      <p>2. Cash/Cheque deposit or Online Transfer into PUBLIC BANK BERHAD 3215930024 under the name of KCRP SOLUTION.</p>
    </div>
  </article>
  );
}
