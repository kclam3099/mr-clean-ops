import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for Server Components and Server Actions —
 * anon/publishable key plus the caller's session cookie, so RLS applies
 * as that specific user (Blueprint v0.2 §F). This is what every normal
 * read/write goes through; it has no more access than the signed-in
 * user's own policies grant.
 *
 * Setting a cookie from a Server Component (not a Server Action or Route
 * Handler) throws in Next.js — the try/catch below is the documented
 * @supabase/ssr pattern for that, and is harmless as long as middleware
 * is refreshing the session (added when auth/middleware lands).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component — safe to ignore once
            // middleware is refreshing sessions on every request.
          }
        },
      },
    },
  );
}
