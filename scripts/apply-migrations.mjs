// Apply the repository's migrations to the TEST project, in order.
//
// TEST is brought forward by APPLYING 0001–0010, never by editing them. A
// migration that has already been recorded is skipped, so this is safe to run
// again; a migration that fails takes its whole file down with it, because a
// half-applied schema is worse than an unapplied one.
//
// Records into supabase_migrations.schema_migrations using the same shape the
// Supabase CLI uses, so `supabase db push` and `npm run db:check-parity` agree
// about what is applied.
//
// This never targets DEV. The guard is the same fail-closed one every
// destructive suite uses: the ref parsed from the live connection must equal
// EXPECTED_TEST_PROJECT_REF and appear on the reviewed allowlist.
//
// Run: npm run db:migrate-test

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import {
  loadEnvLocal, resolveTestTarget, assertTestTarget, projectRef, DEV_PROJECT_REF, missingTestEnv,
} from '../supabase/tests/lib/target.mjs';

loadEnvLocal();
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const missing = missingTestEnv();
if (missing.length) {
  console.error(`\nCannot migrate TEST: missing ${missing.join(', ')} in .env.local.`);
  process.exit(2);
}

const ref = assertTestTarget();
if (ref === DEV_PROJECT_REF) {
  // Unreachable while DEV is off the allowlist; kept because "unreachable" is a
  // claim about today's constants, and this file applies DDL.
  console.error('\nRefusing: this resolved to DEV. Migrations are applied to DEV deliberately, not by a test script.');
  process.exit(2);
}

const target = resolveTestTarget();
if (projectRef(target.url) !== ref) {
  console.error('\nRefusing: the URL and the proven ref disagree.');
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
  host: target.dbHost, port: 5432, user: target.dbUser,
  password: target.dbPassword, database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

console.log(`TEST project ${ref} — ${files.length} migration(s) in the repository\n`);

try {
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
      console.error(`\n${m.file} failed and was rolled back:\n  ${e.message}\n` +
        `\nNothing after it was applied. Fix the cause; do not edit a migration that has\n` +
        `already been applied to another project.`);
      process.exit(1);
    }
  }

  const { rows: final } = await db.query(
    `select version, coalesce(name,'') name from supabase_migrations.schema_migrations order by version`);
  console.log(`\napplied ${ran}, skipped ${skipped}`);
  console.log(`TEST now reports: ${final.map((r) => `${r.version}_${r.name}`).join(', ')}`);
  console.log('\nNow prove parity:  npm run db:check-parity');
} finally {
  await db.end();
}
