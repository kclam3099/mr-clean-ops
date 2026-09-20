// Create the PRODUCTION Supabase project via the Management API.
//
// This exists because creating a project needs a credential, and the two ways
// to hold one are not equivalent. Logging into the dashboard as the owner and
// typing their password is not something this tooling should ever do. A
// personal access token the owner issued, stored in the gitignored .env.local
// and never printed, is -- it is scoped, revocable, and visible to them in the
// dashboard whenever they want to check what it has been used for.
//
// So: the owner issues the token, and everything after that is automated.
//
// What it does NOT do is guess where production should live. The organization
// and the region are read off the EXISTING Test project, so production lands
// beside Dev and Test rather than in some other organization, or on the other
// side of the planet from the Vercel region that will serve it.
//
// The database password is generated here with crypto.randomBytes and written
// straight into .env.local. It is never printed, never logged, and never
// passed on a command line where a process listing would show it. Rotate it
// whenever you like from the dashboard; nothing in this repository memorises
// it.
//
// Run: npm run db:create-prod

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import crypto from 'node:crypto';
import { loadEnvLocal, DEV_PROJECT_REF } from '../supabase/tests/lib/target.mjs';

loadEnvLocal();
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(REPO, '.env.local');
const NAME = process.env.PROD_PROJECT_NAME || 'mr-clean-ops-prod';

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error(`
Missing SUPABASE_ACCESS_TOKEN in .env.local.

Issue one at  https://supabase.com/dashboard/account/tokens
then add the line

  SUPABASE_ACCESS_TOKEN=sbp_...

to .env.local, which is gitignored. Revoke it from that same page once
provisioning is done -- nothing here needs it afterwards.
`);
  process.exit(2);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.supabase.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    // Never echo the request back: the create call carries db_pass.
    const msg = typeof body === 'object' && body?.message ? body.message : String(body).slice(0, 300);
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${msg}`);
  }
  return body;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace these keys in .env.local in place, appending any that are absent. */
function writeEnv(pairs) {
  let text = readFileSync(ENV_PATH, 'utf8');
  for (const [k, v] of Object.entries(pairs)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}

console.log('Reading the account…');
const projects = await api('/v1/projects');
console.log(`  ${projects.length} existing project(s)`);

const testRef = process.env.EXPECTED_TEST_PROJECT_REF;
const anchor = projects.find((p) => p.id === testRef)
  ?? projects.find((p) => p.id === DEV_PROJECT_REF);
if (!anchor) {
  console.error(`
Refusing: neither Dev nor Test is visible in this account, so there is no
evidence of which organization and region production should join. Check that
SUPABASE_ACCESS_TOKEN belongs to the same account as Dev and Test.
`);
  process.exit(2);
}
console.log(`  anchoring on ${anchor.id === testRef ? 'TEST' : 'DEV'}`
  + ` — org ${anchor.organization_id}, region ${anchor.region}`);

// A second project with the same name in the same org is a mess nobody wants
// to untangle later. If it is already there, adopt it rather than duplicate it.
const existing = projects.find(
  (p) => p.name === NAME && p.organization_id === anchor.organization_id);
let project = existing;

if (existing) {
  console.log(`
"${NAME}" already exists (${existing.id}, ${existing.status}). Not creating a
second one. Its database password cannot be read back through this API -- if
you do not have it, reset it in the dashboard and set
PROD_SUPABASE_DB_PASSWORD in .env.local yourself.`);
} else {
  const dbPass = crypto.randomBytes(32).toString('base64url');
  console.log(`\nCreating "${NAME}" in org ${anchor.organization_id}, region ${anchor.region}…`);
  project = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: NAME,
      organization_id: anchor.organization_id,
      region: anchor.region,
      db_pass: dbPass,
    }),
  });
  console.log(`  created: ${project.id}`);
  writeEnv({ PROD_SUPABASE_DB_PASSWORD: dbPass });
  console.log('  database password generated and written to .env.local (not shown)');
}

const ref = project.id;
if (ref === DEV_PROJECT_REF || ref === testRef) {
  console.error(`\nRefusing: that resolved to ${ref === DEV_PROJECT_REF ? 'DEV' : 'TEST'}.`);
  process.exit(2);
}

process.stdout.write('\nWaiting for it to come up');
let status = project.status;
for (let i = 0; i < 60 && status !== 'ACTIVE_HEALTHY'; i++) {
  await sleep(5000);
  process.stdout.write('.');
  try {
    status = (await api(`/v1/projects/${ref}`)).status;
  } catch { /* transient while provisioning */ }
}
console.log(`\n  status: ${status}`);
if (status !== 'ACTIVE_HEALTHY') {
  console.error(`
Not healthy yet, and nothing is necessarily wrong -- provisioning can take a
few minutes. Re-run this; it will adopt the project rather than make another.`);
  process.exit(1);
}

const keys = await api(`/v1/projects/${ref}/api-keys`);
const anon = keys.find(
  (k) => k.name === 'anon' || k.name === 'publishable' || k.type === 'publishable');
if (!anon?.api_key) {
  console.error(`
Could not read a publishable key automatically. Copy it from the dashboard into
PROD_SUPABASE_ANON_KEY; everything else below is already written.`);
}

writeEnv({
  EXPECTED_PROD_PROJECT_REF: ref,
  PROD_SUPABASE_URL: `https://${ref}.supabase.co`,
  ...(anon?.api_key ? { PROD_SUPABASE_ANON_KEY: anon.api_key } : {}),
  PROD_SUPABASE_DB_HOST: `db.${ref}.supabase.co`,
  PROD_SUPABASE_DB_USER: 'postgres',
});

console.log(`
Written to .env.local (secret values not shown):
  EXPECTED_PROD_PROJECT_REF   ${ref}
  PROD_SUPABASE_URL           https://${ref}.supabase.co
  PROD_SUPABASE_ANON_KEY      ${anon?.api_key ? 'set' : 'NOT SET — copy from the dashboard'}
  PROD_SUPABASE_DB_HOST       db.${ref}.supabase.co
  PROD_SUPABASE_DB_USER       postgres
  PROD_SUPABASE_DB_PASSWORD   ${existing ? 'unchanged' : 'set'}

Next:  npm run db:bootstrap-prod
Then revoke the token at https://supabase.com/dashboard/account/tokens
`);
