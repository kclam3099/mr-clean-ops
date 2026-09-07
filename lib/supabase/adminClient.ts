import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses Row Level Security entirely.
 * `import "server-only"` makes any accidental client-component import a
 * build error, not just a code-review miss.
 *
 * Used in almost no code paths (Blueprint v0.2 §F, Phase 1 Build Plan
 * §1C) — most reads/writes should go through serverClient.ts instead, so
 * RLS stays the enforcement boundary. SUPABASE_SERVICE_ROLE_KEY is not
 * set in any environment yet as of this step; calling this before that
 * env var exists fails loudly rather than silently misbehaving.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "createAdminClient() requires NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY — neither is configured yet in this " +
        "environment. Confirm the caller actually needs to bypass RLS " +
        "before wiring this up (Blueprint v0.2 SS F).",
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
