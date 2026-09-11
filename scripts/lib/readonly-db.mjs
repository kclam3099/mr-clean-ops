// A postgres connection that CANNOT write.
//
// Inspecting DEV is legitimate — reproducing a report, checking what the owner
// actually has in the table. Doing it with the destructive test harness is not.
// So diagnostics get their own connection, and "read-only" here is enforced by
// postgres rather than promised by a comment: the session sets
// `default_transaction_read_only`, and the helper then PROVES it by attempting
// a write and requiring the write to fail.
//
// If the proof does not hold, nothing is returned. A connection that merely
// believes it is read-only is the kind of thing that deletes a customer.

import pg from 'pg';
import { loadEnvLocal } from '../../supabase/tests/lib/target.mjs';

loadEnvLocal();

/**
 * Connect read-only to a resolved target, or exit 2.
 *
 * @param {{url?: string, dbUser?: string, dbHost?: string, dbPassword?: string}} target
 * @param {string} label   what to call this project in messages
 */
export async function readOnlyClient(target, label) {
  const missing = ['dbUser', 'dbPassword'].filter((k) => !target[k]);
  if (missing.length) {
    console.error(`\nCannot inspect ${label}: missing ${missing.join(', ')} in .env.local.`);
    process.exit(2);
  }

  const c = new pg.Client({
    host: target.dbHost, port: 5432, user: target.dbUser,
    password: target.dbPassword, database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query('set session characteristics as transaction read only');
  await c.query('set session default_transaction_read_only = on');

  // Prove it. A temp table is the least intrusive write postgres offers, and a
  // read-only transaction refuses it (25006 read_only_sql_transaction).
  let enforced = false;
  try {
    await c.query('create temporary table _rw_probe (x int)');
  } catch (e) {
    enforced = e.code === '25006';
    if (!enforced) {
      await c.end();
      console.error(`\nRead-only probe against ${label} failed in an unexpected way: ${e.code} ${e.message}`);
      process.exit(2);
    }
  }
  if (!enforced) {
    await c.query('drop table if exists _rw_probe');
    await c.end();
    console.error(`\nRefusing to inspect ${label}: the session accepted a write.\n` +
      `Diagnostics must be physically incapable of changing data, not merely intended to be.`);
    process.exit(2);
  }

  return c;
}
