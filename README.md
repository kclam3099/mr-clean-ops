# Mr Clean & Clean — Ops

Internal Appointment & Staff Operations System — replaces WhatsApp-group
scheduling with one tool that answers "what's actually open next week?"
from real operational capacity.

This repo is separate from the public `mrcleanclean.com` marketing site by
design (deployment isolation). See the design docs for the full picture
before changing anything here:

- **Blueprint v0.2** — business logic, architecture, roles, schema, RLS,
  the Availability Engine, locked decisions.
- **Phase 1 Build Plan** — exact schema DDL, concurrency-safety strategy,
  test plan, and the step-by-step implementation order this repo follows.

## Status

Phase 1, Step 1 (scaffold) — see `supabase/migrations/0001_core_schema.sql`
for the prepared (not yet applied) schema, and the Phase 1 Build Plan §1J
for what steps 2+ build next.

## Stack

Next.js (App Router) + TypeScript strict, Supabase (Postgres + Auth + Row
Level Security), deployed on Vercel. Package manager is npm (this
environment couldn't provision pnpm — see build notes); the recommended
default from the Build Plan can still be adopted later without any code
changes.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in real values — never commit .env.local
npm run dev
```

`npm run dev` / `npm run build` explicitly pass `--webpack` — Turbopack
crashes on at least one Windows dev machine used on this project; webpack
is the reliable default until that's root-caused.

## Environments

- **This Supabase project (`mr-clean-ops`) is development/staging only.**
  Fictional seed data lives here. No real customer or staff data belongs
  in it.
- Production gets a **separate** Supabase project, created only at the
  Stage 3 cutover once schema, RLS, availability logic, concurrency
  protection, and security QA all pass (Blueprint v0.2 §21).
- `app.mrcleanclean.com` DNS is not configured yet — development targets
  the Vercel-assigned preview URL until Stage 3.

## Secrets

Never commit `.env.local`, a database password, a Supabase access token,
a service-role key, or a Vercel token. `.env.example` documents variable
*names* only. See `.gitignore`.
