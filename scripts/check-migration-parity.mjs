// Migration parity: git vs DEV vs TEST.
//
// Two projects mean two chances to be wrong about the schema. A suite that
// passes on TEST and a product that runs on DEV only tell you something if both
// are the same database — otherwise a green run is evidence of nothing.
//
// This check is READ-ONLY against both projects. It never applies a migration
// and never "repairs" DEV to match anything: drift is a fact to be reported and
// decided on by a person. TEST is brought forward deliberately, by applying the
// migrations it is missing, not by a script quietly mutating history.
//
// Run: npm run db:check-parity

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  loadEnvLocal, resolveDevTarget, resolveTestTarget, projectRef, TEST_PROJECT_REQUIRED,
} from '../supabase/tests/lib/target.mjs';
import { readOnlyClient } from './lib/readonly-db.mjs';

loadEnvLocal();
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The migrations in the repository, in filename order. */
function gitMigrations() {
  return readdirSync(resolve(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const m = /^(\d{4})_(.+)\.sql$/.exec(f);
      if (!m) throw new Error(`migration filename is not <version>_<name>.sql: ${f}`);
      return { version: m[1], name: m[2] };
    });
}

/** What a project reports as applied. Read-only. */
async function appliedMigrations(target, label) {
  const ref = projectRef(target.url);
  const db = await readOnlyClient(target, label);
  try {
    const { rows } = await db.query(
      `select version, coalesce(name, '') as name
         from supabase_migrations.schema_migrations
        order by version`);
    return { ref, list: rows.map((r) => ({ version: r.version, name: r.name })) };
  } finally {
    await db.end();
  }
}

const fmt = (l) => l.map((m) => `${m.version}_${m.name}`);

/** First difference between two lists, described in words. */
function firstDifference(a, b, aLabel, bLabel) {
  const A = fmt(a), B = fmt(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) continue;
    if (A[i] === undefined) return `${bLabel} has ${B[i]} at position ${i + 1}; ${aLabel} has nothing`;
    if (B[i] === undefined) return `${aLabel} has ${A[i]} at position ${i + 1}; ${bLabel} has nothing`;
    return `position ${i + 1}: ${aLabel} has ${A[i]}, ${bLabel} has ${B[i]}`;
  }
  return null;
}

const git = gitMigrations();
console.log(`git       ${git.length} migration(s): ${fmt(git).join(', ')}`);

const dev = await appliedMigrations(resolveDevTarget(), 'DEV');
console.log(`DEV       ${dev.list.length} applied (${dev.ref}): ${fmt(dev.list).join(', ')}`);

const testTarget = resolveTestTarget();
const testConfigured = testTarget.mode === 'test' && Boolean(testTarget.url && testTarget.dbUser);
let test = null;
if (testConfigured) {
  test = await appliedMigrations(testTarget, 'TEST');
  console.log(`TEST      ${test.list.length} applied (${test.ref}): ${fmt(test.list).join(', ')}`);
} else if (TEST_PROJECT_REQUIRED) {
  console.error('\nFAIL: the TEST project is required but not configured in this environment.');
  process.exit(1);
} else {
  console.log('TEST      not configured yet (pre-cutover) — that leg is not checked.');
}

const problems = [];
const devVsGit = firstDifference(git, dev.list, 'git', 'DEV');
if (devVsGit) problems.push(`git vs DEV — ${devVsGit}`);
if (test) {
  const testVsGit = firstDifference(git, test.list, 'git', 'TEST');
  if (testVsGit) problems.push(`git vs TEST — ${testVsGit}`);
  const devVsTest = firstDifference(dev.list, test.list, 'DEV', 'TEST');
  if (devVsTest) problems.push(`DEV vs TEST — ${devVsTest}`);
}

console.log('');
if (!problems.length) {
  console.log(testConfigured
    ? 'PARITY OK — git, DEV and TEST report the same migrations in the same order.'
    : 'PARITY OK — git and DEV report the same migrations in the same order.');
  process.exit(0);
}

console.error('MIGRATION DRIFT:');
for (const p of problems) console.error(`  - ${p}`);
console.error(`
Nothing has been changed. Decide what is correct before acting:

  - TEST behind git   apply the missing migrations to TEST, in order.
  - DEV behind git    a migration was written but never applied; apply it
                      deliberately, having read it.
  - a project ahead   something was applied outside the repository. Find out
                      what, and write it down as a migration. Do not delete
                      the row to make this check pass.

This script will not mutate DEV to make itself green.`);
process.exit(1);
