import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/serverClient";

/**
 * Display-safe booking configuration.
 *
 * Comes from the `get_booking_config()` RPC (migration 0007), not from the
 * `business_settings` table — that table is readable only by Masters, so a
 * staff member could not render a duration estimate from it. The RPC exposes
 * exactly three fields and nothing else.
 *
 * Deliberately absent, and not to be added back casually:
 *   full_day_lock_threshold  the UI must not pre-judge whether an override is
 *                            needed; the server decides from real conflicts.
 *   default_day_start/end    staff-specific hours override them, so company
 *                            defaults would mislead. The server returns the
 *                            real window in OUTSIDE_WORKING_HOURS.
 */
export type BookingConfig = {
  rmPerHourRate: number;
  defaultBufferMinutes: number;
  defaultAvailabilityDurationMinutes: number;
};

const FALLBACK: BookingConfig = {
  rmPerHourRate: 200,
  defaultBufferMinutes: 30,
  defaultAvailabilityDurationMinutes: 60,
};

export const getBookingConfig = cache(async (): Promise<BookingConfig> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_booking_config");

  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) {
    // The estimate is cosmetic; the server recalculates everything on save. A
    // config read failure must not block booking.
    console.warn("[getBookingConfig] falling back to defaults", error?.message);
    return FALLBACK;
  }

  return {
    rmPerHourRate: Number(row.rm_per_hour_rate) || FALLBACK.rmPerHourRate,
    defaultBufferMinutes: Number(row.default_buffer_minutes) || FALLBACK.defaultBufferMinutes,
    defaultAvailabilityDurationMinutes:
      Number(row.default_availability_job_duration_minutes) ||
      FALLBACK.defaultAvailabilityDurationMinutes,
  };
});
