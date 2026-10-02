"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";

/**
 * "I have seen today's jobs."
 *
 * The staff id and the date are both derived inside acknowledge_day(), from the
 * session and the server clock. Nothing the browser sends decides whose day is
 * acknowledged or which one, so there is no request a staff member could craft
 * to mark yesterday — or someone else — as seen.
 *
 * Idempotent: tapping twice is not an error and does not move the recorded
 * time, which is the number a Master is reading.
 */

export type AcknowledgeState = { error: string | null; acknowledged: boolean };

export async function acknowledgeTodayAction(): Promise<AcknowledgeState> {
  const session = await getSessionContext();
  if (!session) return { error: "Please sign in again.", acknowledged: false };

  const supabase = await createClient();
  const { error } = await supabase.rpc("acknowledge_day");

  if (error) {
    console.warn("[acknowledgeDay] rpc failed");
    return {
      error: "Could not record that. Check your connection and try again.",
      acknowledged: false,
    };
  }

  // The staff shells read this on every page, so refresh all of them rather
  // than only the one the button happened to be on.
  for (const path of ["/my/today", "/my/tomorrow", "/my/month"]) {
    revalidatePath(path);
  }

  return { error: null, acknowledged: true };
}
