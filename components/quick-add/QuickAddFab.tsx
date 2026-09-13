"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { QuickAddSheet } from "./QuickAddSheet";

/**
 * The persistent + button, mounted once per authenticated shell so it is on
 * every operational surface without per-page wiring.
 *
 * Hidden on the full booking pages: a floating button that opens a booking
 * sheet, on top of a booking form, is noise. That is presentation only — the
 * server decides what may actually be booked.
 */
const SUPPRESSED = ["/appointments/new", "/my/appointments/new"];

export function QuickAddFab({
  businessNow,
}: {
  /** Business-local "YYYY-MM-DDTHH:MM", for the past-appointment prompt. */
  businessNow: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [initialDate, setInitialDate] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  /**
   * Other surfaces ask for the sheet by event rather than mounting their own.
   *
   * The dashboard's month grid has a + on every date, and the point of Quick
   * Add is that there is ONE of it: one parser, one review step, one save path.
   * A second sheet rendered from the grid would be a second booking form by
   * another name — which is exactly what this feature replaced.
   *
   * An event rather than a context provider because the button already lives in
   * the shell beside {children}; a provider would mean restructuring the layout
   * to thread state into a subtree that only needs to shout one date at it.
   */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const date = (e as CustomEvent<{ date?: string }>).detail?.date ?? "";
      setInitialDate(/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "");
      setOpen(true);
    };
    window.addEventListener("quickadd:open", onOpen);
    return () => window.removeEventListener("quickadd:open", onOpen);
  }, []);

  if (SUPPRESSED.includes(pathname)) return null;

  return (
    <>
      {open ? null : (
        <button
          type="button"
          onClick={() => { setInitialDate(""); setOpen(true); }}
          aria-label="New appointment"
          className="fixed bottom-6 right-6 z-40 flex h-14 items-center gap-2 rounded-full bg-slate-900
                     px-5 text-white shadow-lg transition hover:bg-slate-800
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                     focus-visible:outline-slate-900 max-sm:w-14 max-sm:justify-center max-sm:px-0"
        >
          <span aria-hidden="true" className="text-2xl leading-none">+</span>
          {/* Label is inline on desktop, not hover-only: a hover-revealed label
              is unreachable by touch and by keyboard. */}
          <span className="text-sm font-medium max-sm:sr-only">New appointment</span>
        </button>
      )}

      {open ? (
        <QuickAddSheet
          businessNow={businessNow}
          initialDate={initialDate}
          onClose={() => { setOpen(false); setInitialDate(""); }}
          onSuccess={(message) => setToast(message)}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-24 right-6 z-40 rounded-xl bg-slate-900 px-4 py-3 text-sm
                     font-medium text-white shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
