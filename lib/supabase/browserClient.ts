/**
 * Browser-side Supabase client factory — anon key only, safe to ship to
 * the client bundle. Real implementation (via @supabase/ssr) lands with
 * Phase 1 Build Plan step 4 (auth), once NEXT_PUBLIC_SUPABASE_URL and
 * NEXT_PUBLIC_SUPABASE_ANON_KEY are wired up as Vercel env vars.
 */
export {};
