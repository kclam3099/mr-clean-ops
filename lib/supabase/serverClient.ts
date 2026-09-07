/**
 * Server-side Supabase client factory — anon key + the caller's session
 * cookie, so every query still runs through RLS as that user (Blueprint
 * v0.2 §F). This is what Server Actions and Server Components use for
 * normal reads/writes. Implemented in step 4.
 */
export {};
