import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope } from "@/lib/workspace/scope";
import { getCalendarStaff } from "@/lib/agenda/staff";
import { businessToday, addDays, weekRange } from "@/lib/agenda/queries";
import { MAX_RANGE_DAYS } from "@/lib/availability/constants";
import { AvailabilityFinder } from "@/components/availability/AvailabilityFinder";

export const metadata = { title: "Find a time — Mr Clean & Clean Ops" };

/**
 * The operational availability tool.
 *
 * The staff list is server-rendered from the caller's own RLS-visible roster —
 * the same set the calendar rows come from — so a Partner Master simply gets a
 * shorter list of chips with nothing indicating it is shorter.
 */
export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = resolveScope(session, params.ws ?? null);
  const staff = await getCalendarStaff(session, scope);

  const today = businessToday();
  const thisWeek = weekRange(today);
  const nextWeek = weekRange(addDays(thisWeek.from, 7));

  // Every preset is clamped to today and to the RPC's 14-day horizon: it
  // refuses a start in the past, and a span wider than 14 days.
  const clamp = (d: string) => (d < today ? today : d);
  const horizon = addDays(today, MAX_RANGE_DAYS - 1);
  const cap = (d: string) => (d > horizon ? horizon : d);

  const presets = [
    { label: "Today", from: today, to: today },
    { label: "Tomorrow", from: addDays(today, 1), to: addDays(today, 1) },
    { label: "This week", from: clamp(thisWeek.from), to: cap(thisWeek.to) },
    { label: "Next week", from: clamp(nextWeek.from), to: cap(nextWeek.to) },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Find a time</h1>
        <p className="text-sm text-slate-500">{scope.label}</p>
      </div>

      {staff.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          No active team members in this view.
        </p>
      ) : (
        <AvailabilityFinder
          staff={staff}
          scopeValue={scope.kind === "workspace" ? scope.workspaceId : "all"}
          businessToday={today}
          maxDate={horizon}
          presets={presets}
        />
      )}
    </div>
  );
}
