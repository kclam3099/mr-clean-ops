/**
 * Service-role Supabase client factory — bypasses RLS entirely.
 * Server-only, imported in as few places as possible (Blueprint v0.2 §F,
 * Phase 1 Build Plan §1C). SUPABASE_SERVICE_ROLE_KEY must never be
 * prefixed NEXT_PUBLIC_ and must never reach a client bundle. Not wired
 * up yet — no service-role key exists in any environment for this
 * project as of Step 1.
 */
export {};
