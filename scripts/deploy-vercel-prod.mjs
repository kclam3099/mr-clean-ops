// Point Vercel's PRODUCTION environment at the live database and deploy.
//
// The public deployment has been returning 500 because its Production
// environment holds no Supabase variables at all -- Preview and Development
// were configured months ago and Production never was. The app cannot start
// without NEXT_PUBLIC_SUPABASE_URL, so it doesn't.
//
// The database it points at is mr-clean-ops, the project historically labelled
// "DEV". That label was a naming artefact from the first week; the project has
// held real customer bookings and served the owner's day-to-day work for a
// while now. Production is what it already is, so nothing is migrated or
// copied here -- 0001-0010 are applied there and parity has been proven
// against git.
//
// Values are read from .env.local and piped to the Vercel CLI on stdin. They
// are never printed, never passed as arguments, and never written to a temp
// file, because all three end up somewhere readable -- a log, a shell history,
// a process listing.
//
// Before running this, satisfy yourself that Row Level Security is on for
// every public table. The anon key ships to every visitor's browser, so RLS is
// the entire boundary between Nick and Victor's bookings once this is public.
// Checked at the time of writing: 14 of 14 public tables, each with at least
// one policy.
//
// Run: npm run deploy:prod

import { spawn } from 'node:child_process';
import { loadEnvLocal, projectRef, DEV_PROJECT_REF } from '../supabase/tests/lib/target.mjs';

loadEnvLocal();
const env = process.env;

const URL_NAME = 'NEXT_PUBLIC_SUPABASE_URL';
const KEY_NAME = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';

const url = env[URL_NAME];
const key = env[KEY_NAME];
if (!url || !key) {
  console.error(`\nMissing ${!url ? URL_NAME : KEY_NAME} in .env.local.\n`);
  process.exit(2);
}

const ref = projectRef(url);
if (!ref) {
  console.error(`\nRefusing: could not read a project ref out of ${URL_NAME}.\n`);
  process.exit(2);
}

// The intended target is the project this repository has always called DEV.
// Named explicitly so that a later edit to .env.local cannot quietly send the
// public site at a different database than the one that was reviewed.
if (ref !== DEV_PROJECT_REF) {
  console.error(`
Refusing: ${URL_NAME} names ${ref}, which is not the project this deploy was
reviewed for (${DEV_PROJECT_REF}). If production really is moving, change it
here deliberately rather than by editing .env.local.
`);
  process.exit(2);
}

console.log(`Production database : ${ref}`);
console.log(`Vercel environment  : production\n`);

/** Run a command, optionally writing `stdin` to it. Never echoes stdin. */
const run = (args, stdin = null, { quiet = false } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'vercel.cmd' : 'vercel', args, {
      stdio: [stdin === null ? 'inherit' : 'pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    if (stdin !== null) { child.stdin.write(stdin); child.stdin.end(); }
    child.on('close', (code) => {
      if (!quiet) {
        // Strip anything shaped like a credential before showing CLI output.
        const safe = out
          .split('\n')
          .filter((l) => !/eyJ|sb_secret|sbp_|service_role/.test(l))
          .map((l) => l.replace(/https:\/\/[a-z0-9]{20}\.supabase\.co/g, `https://${ref}.supabase.co`))
          .join('\n');
        process.stdout.write(safe.trim() ? `${safe.trim()}\n` : '');
      }
      resolve(code ?? 1);
    });
  });

for (const [name, value] of [[URL_NAME, url], [KEY_NAME, key]]) {
  // Remove first: `env add` refuses when the variable already exists, and a
  // stale value is exactly the failure this script exists to end.
  await run(['env', 'rm', name, 'production', '--yes'], null, { quiet: true });
  // --visibility config --no-sensitive is required, not cosmetic. The CLI
  // defaults to storing a variable encrypted, and Vercel refuses that for a
  // NEXT_PUBLIC_* name on Production: anything with that prefix is compiled
  // into the browser bundle, so calling it a secret would be a lie the
  // platform declines to tell. Without these flags every add fails with
  // invalid_visibility and nothing deploys.
  const code = await run(
    ['env', 'add', name, 'production', '--visibility', 'config', '--no-sensitive'],
    value, { quiet: true });
  console.log(`  ${code === 0 ? 'set  ' : 'FAILED'} ${name}`);
  if (code !== 0) {
    console.error(`\nCould not set ${name}. Nothing was deployed.\n`);
    process.exit(1);
  }
}

console.log('\nDeploying to production…\n');
const code = await run(['--prod']);
if (code !== 0) {
  console.error('\nDeploy failed. The environment variables are set; re-run to retry.\n');
  process.exit(1);
}

console.log(`
Deployed. Check it:

  curl -s -o /dev/null -w "%{http_code}\\n" https://mr-clean-ops.vercel.app/login

A 200 means the app reached ${ref}. A 500 means it still cannot, and the
Vercel runtime logs will say which variable it is missing.
`);
