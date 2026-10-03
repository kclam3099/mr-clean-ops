import { getI18n } from "@/lib/i18n/server";
import { SignOutButton } from "./SignOutButton";

/**
 * Shown on every page of a session opened with the master password, so the
 * owner always knows they are inside someone else's account — and anything
 * done here is done as that person.
 */
export async function MasterViewBanner({ name }: { name: string }) {
  const { t } = await getI18n();
  return (
    <div data-master-view className="flex items-center justify-between gap-3 bg-gold px-4 py-1.5 text-sm font-semibold text-brand-900">
      <span>{t("Monitoring login — you are signed in as {name}.", { name })}</span>
      <SignOutButton className="!min-h-8 !px-2 !py-0 !text-brand-900 hover:!bg-black/10" />
    </div>
  );
}
