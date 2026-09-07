import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client — anon/publishable key only, safe to ship
 * to the client bundle. Every query still runs through Row Level Security
 * as the signed-in user (Blueprint v0.2 §F); this client has no elevated
 * access of its own.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
