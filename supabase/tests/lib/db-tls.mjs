// TLS settings for every direct Postgres connection in this repository.
//
// Supabase serves database connections from a chain rooted in "Supabase Root
// 2021 CA" -- its own private root, which is deliberately not in Node's bundled
// Mozilla trust store. Node reports that as SELF_SIGNED_CERT_IN_CHAIN, which
// reads like a broken certificate but means only "this chain ends at a root I
// was not given".
//
// The tempting fix is rejectUnauthorized:false, and it is the wrong one: it
// does not trust Supabase's root, it stops checking altogether, so any host
// that can answer on that address is accepted and the connection -- carrying
// the database password -- is no longer authenticated at all.
//
// Instead we pin that one root. This is STRICTER than ordinary public trust:
// the default store would accept a certificate from any of roughly 150 public
// CAs, and this accepts exactly one. Hostname verification stays on, so the
// result is equivalent to libpq's sslmode=verify-full.
//
// The certificate is public -- it is served over plain HTTPS by Supabase and
// its whole purpose is to be distributed -- so it lives in the repository. It
// was fetched out of band rather than taken from the chain the database itself
// presented, because reading the root out of that chain would mean trusting
// whatever the server chose to send. Its SHA-256 was then compared against the
// root the pooler actually serves:
//
//   Supabase Root 2021 CA
//   80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:
//   82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
//   valid Apr 28 2021 -> Apr 26 2031
//
// To refresh it: download from Supabase, compare the fingerprint to the root
// the server presents, and only then replace the file. Never copy a root out
// of a live chain without that out-of-band check.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import crypto from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CA_PATH = resolve(HERE, '../../certs/prod-ca-2021.crt');

export const SUPABASE_ROOT_2021_SHA256 =
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:' +
  '82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

let cached = null;

/** The pinned root, read once. Throws if the file is missing or not that root. */
export function supabaseRootCa() {
  if (cached) return cached;
  let pem;
  try {
    pem = readFileSync(CA_PATH, 'utf8');
  } catch {
    throw new Error(
      `Supabase root CA not found at ${CA_PATH}.\n` +
      `Download it from Supabase and verify its SHA-256 is ${SUPABASE_ROOT_2021_SHA256}\n` +
      `before putting it there. Do not disable certificate verification instead.`);
  }
  // A wrong file here would silently become "the thing we trust", so check it
  // is the certificate this module claims to pin.
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const fp = crypto.createHash('sha256').update(der).digest('hex')
    .match(/../g).join(':').toUpperCase();
  if (fp !== SUPABASE_ROOT_2021_SHA256) {
    throw new Error(
      `The certificate at ${CA_PATH} is not the root this module pins.\n` +
      `  expected ${SUPABASE_ROOT_2021_SHA256}\n  found    ${fp}\n` +
      `Refusing to trust it.`);
  }
  cached = pem;
  return pem;
}

/**
 * ssl config for pg.Client. Verification stays ON; the chain is checked against
 * Supabase's root and the hostname is checked as usual.
 */
export function dbSsl() {
  return { ca: supabaseRootCa(), rejectUnauthorized: true };
}
