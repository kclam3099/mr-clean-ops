"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { resolveScope } from "@/lib/workspace/scope";
import { getCalendarStaff } from "@/lib/agenda/staff";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";
// Checked here too, so the user gets a precise message rather than the generic
// mapping of the RPC's own `Range too large`.
import { MAX_RANGE_DAYS } from "@/lib/availability/constants";

/**
 * "Find a time" — the operational availability tool.
 *
 * It calls the SAME four-argument RPC as the booking form:
 *
 *   find_available_slots(p_staff_ids, p_from, p_to, p_workspace_id)
 *
 * No amount, no duration, no buffer, no caller-supplied probe times. Migration
 * 0007 removed the amount-taking signature because varying it let a caller
 * binary-search a hidden appointment's start time. Nothing here may reintroduce
 * that, in any shape.
 *
 * Results are available rows only. There is deliberately no "why not" for a
 * slot that is missing: a hidden appointment simply removes it, and saying more
 * would disclose the thing the RPC exists to hide.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const searchSchema = z.object({
  scopeValue: z.string().optional(),
  staffIds: z.array(z.string().uuid()).max(50),
  from: isoDate,
  to: isoDate,
});

export type AvailabilitySlot = {
  staffId: string;
  staffName: string;
  date: string;
  time: string;
};

export type AvailabilitySearchResult =
  | { status: "ok"; slots: AvailabilitySlot[] }
  | { status: "error"; error: AppError };

export async function findTimesAction(raw: unknown): Promise<AvailabilitySearchResult> {
  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const parsed = searchSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  }
  const input = parsed.data;

  if (input.from > input.to) {
    return {
      status: "error",
      error: { ...appError(AppErrorCode.VALIDATION_ERROR), message: "The end date is before the start date." },
    };
  }
  if (daysBetween(input.from, input.to) >= MAX_RANGE_DAYS) {
    return {
      status: "error",
      error: {
        ...appError(AppErrorCode.VALIDATION_ERROR),
        message: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.`,
      },
    };
  }

  // Scope and the staff roster are re-derived from the session. A staff id the
  // caller cannot see is dropped here, so a forged one behaves exactly like a
  // random one: it simply is not asked about.
  const scope = resolveScope(session, input.scopeValue ?? null);
  const visible = await getCalendarStaff(session, scope);
  const visibleIds = new Set(visible.map((s) => s.id));
  const targets = input.staffIds.filter((id) => visibleIds.has(id));

  // Nothing askable — the same empty answer a genuinely empty schedule gives.
  if (visible.length === 0 || (input.staffIds.length > 0 && targets.length === 0)) {
    return { status: "ok", slots: [] };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_available_slots", {
    p_staff_ids: targets.length > 0 ? targets : visible.map((s) => s.id),
    p_from: input.from,
    p_to: input.to,
    // "All Operations" is virtual and has no id; omitting the workspace is what
    // makes the RPC merge exactly the workspaces RLS already allows.
    p_workspace_id: scope.kind === "workspace" ? scope.workspaceId : null,
  });

  if (error) return { status: "error", error: logAndMap("findTimes", error) };

  const names = new Map(visible.map((s) => [s.id, s.name]));
  const rows = (data ?? []) as Array<{ staff_id: string; slot_date: string; slot_time: string }>;

  const slots = rows
    // A row for someone this caller cannot name should never render. The RPC
    // already scopes to their workspaces; this is the belt to that braces.
    .filter((r) => names.has(r.staff_id))
    .map((r) => ({
      staffId: r.staff_id,
      staffName: names.get(r.staff_id) as string,
      date: r.slot_date,
      time: r.slot_time.slice(0, 5),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
      || a.staffName.localeCompare(b.staffName));

  return { status: "ok", slots };
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
