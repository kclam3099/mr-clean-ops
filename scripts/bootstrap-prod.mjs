// Bring PRODUCTION up to the repository's schema by applying 0001-0010 in order.
//
// This is the mirror of scripts/apply-migrations.mjs, with the guard pointing
// the other way. That file proves it is talking to TEST and refuses anything
// else; this one proves it is talking to NEITHER Dev nor Test, because the one
// thing a production bootstrap must never do is run against a project someone
// is still developing or testing against.
//
// Production deliberately appears on no allowlist. TEST_SAFE_PROJECT_REFS is
// the permission to WIPE a project, and nothing about production should ever
// carry that permission, so the check here is an explicit denylist plus a
// declared ref that must match, rather than membership of a safe list.
//
// Applying is idempotent: a migration already recorded is skipped, and any
// migration that fails takes its own file down with it and stops the run.
//
// Run: npm run db:bootstrap-prod

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { loadEnvLocal, projectRef, DEV_PROJECT_REF } from '../supabase/tests/lib/target.mjs';

loadEnvLocal();
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const REQUIRED = [
  'EXPECTED_PROD_PROJECT_REF',
  'PROD_SUPABASE_URL',
  'PROD_SUPABASE_DB_HOST',
  'PROD_SUPABASE_DB_USER',
  'PROD_SUPABASE_DB_PASSWORD',
];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`\nCannot bootstrap production: missing ${missing.join(', ')} in .env.local.`);
  console.error(`\nCreate the project in the Supabase dashboard first, then add those five`);
  console.error(`values. Nothing here invents them, and nothing here creates a project.`);
  process.exit(2);
}

const declared = env.EXPECTED_PROD_PROJECT_REF;
const fromUrl = projectRef(env.PROD_SUPABASE_URL);
const fromHost = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(env.PROD_SUPABASE_DB_HOST)?.[1]
  ?? /(?:^|\.)([a-z0-9]{20})\./.exec(env.PROD_SUPABASE_DB_HOST)?.[1];

// Three independent statements of which project this is. They must agree, so a
// half-edited .env.local cannot point the URL at one project and the database
// at another -- which is exactly how a "production" migration lands on Dev.
const claims = { EXPECTED_PROD_PROJECT_REF: declared, PROD_SUPABASE_URL: fromUrl, PROD_SUPABASE_DB_HOST: fromHost };
for (const [k, v] of Object.entries(claims)) {
  if (!v) { console.error(`\nRefusing: could not read a project ref out of ${k}.`); process.exit(2); }
}
if (new Set(Object.values(claims)).size !== 1) {
  console.error(`\nRefusing: the three sources disagree about which project this is.`);
  for (const [k, v] of Object.entries(claims)) console.error(`  ${k.padEnd(28)} ${v}`);
  process.exit(2);
}
const ref = declared;

const FORBIDDEN = new Map([
  [DEV_PROJECT_REF, 'DEV -- the project holding the owner\'s real bookings'],
  [env.EXPECTED_TEST_PROJECT_REF, 'TEST -- the project the automated suites wipe'],
].filter(([k]) => k));
if (FORBIDDEN.has(ref)) {
  console.error(`\nRefusing: ${ref} is ${FORBIDDEN.get(ref)}.`);
  console.error(`Production must be a project of its own, on no allowlist.`);
  process.exit(2);
}

const files = readdirSync(resolve(REPO, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => {
    const m = /^(\d{4})_(.+)\.sql$/.exec(f);
    if (!m) throw new Error(`migration filename is not <version>_<name>.sql: ${f}`);
    return { file: f, version: m[1], name: m[2] };
  });

const db = new pg.Client({
  host: env.PROD_SUPABASE_DB_HOST, port: 5432, user: env.PROD_SUPABASE_DB_USER,
  password: env.PROD_SUPABASE_DB_PASSWORD, database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

console.log(`PRODUCTION project ${ref} — ${files.length} migration(s) in the repository\n`);

try {
  // A project that already holds appointments is not a fresh production
  // project; it is something else wearing the name, and applying DDL to it
  // blind is how the wrong database gets rewritten.
  const { rows: [pre] } = await db.query(`
    select to_regclass('public.appointments') is not null as has_schema,
           coalesce((select count(*) from information_schema.tables
                     where table_schema = 'public'), 0)::int as public_tables`);
  if (pre.has_schema) {
    const { rows: [n] } = await db.query(`select count(*)::int c from public.appointments`);
    console.log(`  note: schema already present, ${n.c} appointment(s) — continuing idempotently\n`);
  } else {
    console.log(`  fresh project (${pre.public_tables} table(s) in public)\n`);
  }

  await db.query(`create schema if not exists supabase_migrations`);
  await db.query(`
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    )`);

  const { rows: already } = await db.query(
    `select version from supabase_migrations.schema_migrations`);
  const applied = new Set(already.map((r) => r.version));

  let ran = 0, skipped = 0;
  for (const m of files) {
    if (applied.has(m.version)) {
      console.log(`  skip   ${m.version}_${m.name} (already recorded)`);
      skipped++;
      continue;
    }
    const sql = readFileSync(resolve(REPO, 'supabase/migrations', m.file), 'utf8');
    process.stdout.write(`  apply  ${m.version}_${m.name} … `);
    try {
      await db.query('begin');
      await db.query(sql);
      await db.query(
        `insert into supabase_migrations.schema_migrations (version, name, statements)
         values ($1, $2, $3)`,
        [m.version, m.name, [sql]]);
      await db.query('commit');
      console.log('ok');
      ran++;
    } catch (e) {
      await db.query('rollback').catch(() => {});
      console.log('FAILED');
      console.error(`\n${m.file} failed and was rolled back:\n  ${e.message}\n`);
      console.error(`Nothing after it was applied.`);
      process.exit(1);
    }
  }

  const { rows: final } = await db.query(
    `select version, coalesce(name,'') name from supabase_migrations.schema_migrations order by version`);
  const { rows: [rls] } = await db.query(`
    select count(*) filter (where c.relrowsecurity)::int as with_rls,
           count(*)::int as total
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`);

  console.log(`\napplied ${ran}, skipped ${skipped}`);
  console.log(`production now reports: ${final.map((r) => `${r.version}_${r.name}`).join(', ')}`);
  console.log(`RLS: ${rls.with_rls}/${rls.total} public tables have row level security enabled`);
  if (rls.with_rls !== rls.total) {
    console.log(`\nWARNING: a public table without RLS is readable by anyone holding the`);
    console.log(`anon key, which ships in the browser. Check before putting real data in.`);
  }
} finally {
  await db.end();
}
