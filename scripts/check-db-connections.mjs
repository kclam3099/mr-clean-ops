// Can this machine reach the databases?
//
// Exists because "it does not work" covers several different problems that
// look identical from the outside, and guessing between them wastes an
// afternoon. This names which one it is:
//
//   28P01   the password in .env.local is not the password on the server
//   ENOTFOUND / EAI_AGAIN   the host does not resolve — usually a paused
//           project, since Supabase withdraws DNS while a project is paused
//   XX000   the pooler does not host that tenant — wrong pooler hostname
//   ETIMEDOUT   something between here and there is dropping the connection
//
// Nothing secret is printed. Passwords are reported only as a length and a
// character profile, which is enough to spot an empty value or a stray quote
// and not enough to be worth anything to anyone reading over a shoulder.
//
// Run: npm run db:check-conn

import pg from 'pg';
import { loadEnvLocal } from '../supabase/tests/lib/target.mjs';
import { dbSsl } from '../supabase/tests/lib/db-tls.mjs';

loadEnvLocal();
const env = process.env;

const TARGETS = [
  {
    label: 'PRODUCTION (mr-clean-ops)',
    host: env.SUPABASE_DB_HOST,
    user: env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    passwordVar: 'SUPABASE_DB_PASSWORD',
  },
  {
    label: 'TEST (mr-clean-ops-test)',
    host: env.TEST_SUPABASE_DB_HOST,
    user: env.TEST_SUPABASE_DB_USER,
    password: env.TEST_SUPABASE_DB_PASSWORD,
    passwordVar: 'TEST_SUPABASE_DB_PASSWORD',
  },
];

const EXPLAIN = {
  '28P01': 'the password in .env.local does not match the one on the server',
  XX000: 'the pooler does not host this project — check the host name',
  ENOTFOUND: 'host does not resolve — the project may be paused',
  EAI_AGAIN: 'host does not resolve — the project may be paused',
  ETIMEDOUT: 'no answer — network or firewall',
  ECONNREFUSED: 'refused — the project may still be starting',
};

function profile(v) {
  if (v === undefined) return 'NOT SET';
  if (v === '') return 'EMPTY';
  const bits = [`${v.length} chars`];
  if (v !== v.trim()) bits.push('HAS WHITESPACE');
  if (/^["']|["']$/.test(v)) bits.push('HAS QUOTES — remove them');
  if (/[^\x20-\x7E]/.test(v)) bits.push('HAS NON-ASCII');
  return bits.join(', ');
}

let bad = 0;

for (const t of TARGETS) {
  console.log(`\n${t.label}`);
  console.log(`  host     ${t.host ?? 'NOT SET'}`);
  console.log(`  user     ${t.user ?? 'NOT SET'}`);
  console.log(`  password ${profile(t.password)}   (${t.passwordVar})`);

  if (!t.host || !t.user || !t.password) {
    console.log('  result   cannot try — something above is not set');
    bad++;
    continue;
  }

  const client = new pg.Client({
    host: t.host, port: 5432, user: t.user, password: t.password,
    database: 'postgres', ssl: dbSsl(), connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    const { rows: [r] } = await client.query(
      `select current_database() as db,
              (select count(*) from public.appointments)::int as appointments`);
    console.log(`  result   CONNECTED — ${r.db}, ${r.appointments} appointment(s)`);
    await client.end();
  } catch (e) {
    const code = e.code ?? '';
    console.log(`  result   FAILED ${code}${EXPLAIN[code] ? ` — ${EXPLAIN[code]}` : ''}`);
    if (code === '28P01') {
      console.log(`           Reset it at`);
      console.log(`           https://supabase.com/dashboard/project/` +
        `${/postgres\.([a-z0-9]+)/.exec(t.user)?.[1] ?? '<ref>'}/settings/database`);
      console.log(`           then put the NEW value in ${t.passwordVar} in .env.local.`);
    }
    bad++;
  }
}

console.log(bad === 0
  ? '\nBoth databases are reachable.\n'
  : `\n${bad} of ${TARGETS.length} could not be reached.\n`);

process.exitCode = bad === 0 ? 0 : 1;
