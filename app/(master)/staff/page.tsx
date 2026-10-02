// Phase 1 Step 1 scaffold placeholder — route wiring lands in a later
// implementation-order step (see Phase 1 Build Plan §1J).
import { getI18n } from "@/lib/i18n/server";

export default async function Page() {
  const { t } = await getI18n();
  return (
    <main style={{ padding: 24 }}>
      <h1>{t("Staff")}</h1>
      <p>{t("Not implemented yet — Phase 1 scaffold placeholder.")}</p>
    </main>
  );
}
