"use client";

import { useT } from "@/components/i18n/I18nProvider";

/** Opens the browser's print dialog — "Save as PDF" lives there on every device. */
export function PrintButton() {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="cursor-pointer rounded-lg bg-[#0D3D66] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
    >
      {t("Save as PDF / Print")}
    </button>
  );
}
