import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { businessToday, addDays, weekRange } from "@/lib/agenda/queries";
import { MAX_RANGE_DAYS } from "@/lib/availability/constants";
import { CustomerAvailability } from "@/components/availability/CustomerAvailability";
import { findCustomerAvailabilityAction } from "@/lib/availability/queries";
import { buildCustomerMessage } from "@/lib/availability/customer-message";
import type { RangePreset } from "@/lib/availability/customer-message";

export const metadata = { title: "Available times — Mr Clean & Clean Ops" };

/**
 * "When are you available?" — answered as a message the owner can paste
 * straight into WhatsApp.
 *
 * There is no staff picker. The customer does not care who comes, the message
 * never names anyone, and the operational team is resolved server-side from the
 * caller's own visible workspaces — so a Partner Master gets the same
 * customer-facing output with no way to reach a private team.
 */
export default async function AvailabilityPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const today = businessToday();
  const thisWeek = weekRange(today);
  const nextWeek = weekRange(addDays(thisWeek.from, 7));

  // Clamped to today and to the RPC's horizon: it refuses a start in the past,
  // and a span wider than 14 days.
  const clamp = (d: string) => (d < today ? today : d);
  const horizon = addDays(today, MAX_RANGE_DAYS - 1);
  const cap = (d: string) => (d > horizon ? horizon : d);

  const presets: Array<{ key: RangePreset; label: string; from: string; to: string }> = [
    { key: "today", label: "Today", from: today, to: today },
    { key: "tomorrow", label: "Tomorrow", from: addDays(today, 1), to: addDays(today, 1) },
    { key: "thisWeek", label: "This week", from: clamp(thisWeek.from), to: cap(thisWeek.to) },
    { key: "nextWeek", label: "Next week", from: clamp(nextWeek.from), to: cap(nextWeek.to) },
  ];

  // The commonest question is "this week", so answer it before the page paints
  // rather than after a round trip.
  const initialPreset: RangePreset = "thisWeek";
  const initialRange = presets.find((p) => p.key === initialPreset)!;
  const initial = await findCustomerAvailabilityAction({
    from: initialRange.from, to: initialRange.to });
  const initialMessage = initial.status === "ok"
    ? buildCustomerMessage(initial.slots, initialPreset)
    : buildCustomerMessage([], initialPreset);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Available times</h1>
        <p className="text-sm text-slate-500">
          Copy the message and send it to the customer.
        </p>
      </div>

      <CustomerAvailability
        presets={presets}
        initialPreset={initialPreset}
        initialMessage={initialMessage}
        businessToday={today}
        maxDate={horizon}
      />
    </div>
  );
}
