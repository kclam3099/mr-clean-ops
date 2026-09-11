// Which Supabase project an automated suite is allowed to touch.
//
// Identity is a PROJECT REF — the 20-character id in
// https://<ref>.supabase.co — and nothing else. Not a hostname substring:
// "test" or "dev" appearing in a URL proves nothing, and a production project
// could contain either word. Two projects, one letter apart, are different
// projects; a ref comparison sees that and a pattern does not.
//
// Every decision here is fail-closed. A missing variable, an unparseable URL,
// an unknown ref and a ref that disagrees with what the environment claims all
// resolve to "no". The default answer is no, and widening it is a diff someone
// reviews.
//
// The pure core is `evaluateTarget`, so the guard matrix can be exercised by
// tests/unit/test-target.test.mjs without touching a network or a database.
// The exported guards are thin wrappers that print and exit.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Load .env.local without overwriting anything already exported.
 *
 * A real environment variable always wins, so `EXPECTED_TEST_PROJECT_REF=… node …`
 * behaves the way anyone would expect. .env.local is gitignored; no value from
 * it is ever printed.
 */
export function loadEnvLocal(env = process.env) {
  const p = resolve(REPO, '.env.local');
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// ---------------------------------------------------------------------------
// Reviewed allowlists
// ---------------------------------------------------------------------------

/**
 * Projects an automated suite may create and DELETE rows in.
 *
 * DEV is on this list only until the dedicated TEST project exists. The cutover
 * commit removes it, after which a destructive suite is physically incapable of
 * resolving DEV: not discouraged from it, incapable of it.
 */
export const TEST_SAFE_PROJECT_REFS = [
  'ozojfflkchltwqnbflso', // DEV — removed at cutover, see docs/DEV-TEST-SEPARATION.md
];

/**
 * Projects the reset/seed command may EMPTY.
 *
 * Strictly narrower than test-safe, and deliberately separate: being allowed to
 * clean up after yourself is not the same permission as being allowed to wipe a
 * table. DEV must never appear here. Production must never appear here, and
 * cannot be put here by an environment variable — only by editing this file.
 */
export const WIPEABLE_PROJECT_REFS = [];

/** DEV, named so a refusal can say which project it refused and why. */
export const DEV_PROJECT_REF = 'ozojfflkchltwqnbflso';

/**
 * Flipped to true in the cutover commit, once the TEST project exists.
 *
 * While false, suites resolve the legacy DEV variables and the allowlist above
 * is what protects them. Once true there is no fallback at all: TEST_SUPABASE_*
 * and EXPECTED_TEST_PROJECT_REF become mandatory, and a machine that has not
 * been configured for TEST runs nothing rather than quietly running against the
 * owner's data.
 */
export const TEST_PROJECT_REQUIRED = false;

/**
 * Overrides that are not honoured — including ones that never existed.
 *
 * ALLOW_NON_DEV_TESTS was real and was removed. The rest are listed because a
 * plain boolean is exactly the shape of workaround someone invents at 1am. If
 * any of them is set we refuse outright rather than ignoring it silently, so
 * the attempt surfaces instead of being papered over.
 */
const FORBIDDEN_OVERRIDES = [
  'ALLOW_NON_DEV_TESTS',
  'ALLOW_PROD_TESTS',
  'ALLOW_DEV_TESTS',
  'SKIP_TARGET_GUARD',
  'FORCE_TEST_TARGET',
];

// ---------------------------------------------------------------------------
// ref parsing
// ---------------------------------------------------------------------------

/**
 * The project ref out of a Supabase URL.
 *
 * Anchored and exact-length: a ref is 20 lowercase alphanumerics, so
 * `https://evil.example/ozojfflkchltwqnbflso.supabase.co` does not match and
 * neither does a 19- or 21-character lookalike.
 */
export function projectRef(url) {
  if (typeof url !== 'string') return null;
  const m = /^https?:\/\/([a-z0-9]{20})\.supabase\.(co|in|net)$/i.exec(url.trim().replace(/\/+$/, ''));
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// the pure decision
// ---------------------------------------------------------------------------

/**
 * Decide whether `url` may be written to. Pure: no I/O, no exit.
 *
 * @param {object} o
 * @param {string|undefined} o.url          resolved Supabase URL
 * @param {string|undefined} o.expectedRef  EXPECTED_TEST_PROJECT_REF, if set
 * @param {string[]} o.safeRefs             reviewed test-safe allowlist
 * @param {string[]} [o.wipeableRefs]       reviewed wipeable allowlist
 * @param {boolean} [o.wipe]                require wipe authority as well
 * @param {boolean} [o.requireExpected]     TEST_PROJECT_REQUIRED
 * @param {Record<string,string|undefined>} [o.env] environment, for the override check
 * @returns {{ok: true, ref: string} | {ok: false, code: string, message: string}}
 */
export function evaluateTarget({
  url, expectedRef, safeRefs, wipeableRefs = [], wipe = false,
  requireExpected = false, env = {},
}) {
  const set = FORBIDDEN_OVERRIDES.filter((k) => env[k] !== undefined && env[k] !== '');
  if (set.length) {
    return {
      ok: false, code: 'FORBIDDEN_OVERRIDE',
      message: `${set.join(', ')} is set. This project has no boolean escape hatch: a target is\n` +
        `proven by project ref or it is refused. Unset it and point the TEST_* variables at\n` +
        `the project you actually mean.`,
    };
  }

  if (!url) {
    return {
      ok: false, code: 'NO_URL',
      message: 'No Supabase URL resolved. Nothing is assumed about an unset target.',
    };
  }

  const ref = projectRef(url);
  if (!ref) {
    return {
      ok: false, code: 'UNPARSEABLE',
      message: `Cannot read a Supabase project ref from ${url}.\n` +
        `An unrecognised target is refused, because this run writes to the database.`,
    };
  }

  if (requireExpected && !expectedRef) {
    return {
      ok: false, code: 'NO_EXPECTED',
      message: 'EXPECTED_TEST_PROJECT_REF is not set.\n' +
        'Since the TEST project exists, the environment must state which project it\n' +
        'believes it is talking to, and that claim must match the connection.',
    };
  }

  if (expectedRef && ref !== expectedRef) {
    const dev = ref === DEV_PROJECT_REF ? '\nThat ref is DEV — the owner\'s data. Refusing.' : '';
    return {
      ok: false, code: 'MISMATCH',
      message: `The environment expects project ${expectedRef} but the connection resolves to ${ref}.${dev}\n` +
        `Both must agree: a stale copied .env is exactly how a suite ends up somewhere it was\n` +
        `never meant to be.`,
    };
  }

  if (!safeRefs.includes(ref)) {
    const dev = ref === DEV_PROJECT_REF
      ? `\n${ref} is DEV. Automated destructive suites are not permitted to target it;\n` +
        `use the read-only diagnostic workflow (npm run dev:inspect) instead.`
      : '';
    return {
      ok: false, code: 'NOT_ALLOWLISTED',
      message: `Refusing to run against project ${ref}.${dev}\n` +
        `Test-safe projects: ${safeRefs.length ? safeRefs.join(', ') : '(none configured)'}.\n` +
        `Allowing a project means adding its ref to TEST_SAFE_PROJECT_REFS in\n` +
        `supabase/tests/lib/target.mjs — a reviewed change, not an environment variable.`,
    };
  }

  if (wipe && !wipeableRefs.includes(ref)) {
    return {
      ok: false, code: 'NOT_WIPEABLE',
      message: `Project ${ref} may be used by tests, but may not be EMPTIED.\n` +
        `Wipeable projects: ${wipeableRefs.length ? wipeableRefs.join(', ') : '(none configured)'}.\n` +
        `Being allowed to clean up after yourself is not permission to wipe a table.`,
    };
  }

  return { ok: true, ref };
}

// ---------------------------------------------------------------------------
// environment resolution
// ---------------------------------------------------------------------------

/**
 * Variables the TEST project needs. Presence is validated; values never print.
 *
 * `secretKey` is deliberately absent from this list. Ordinary suites must run
 * without it — see `requireTestSecretKey`.
 */
export const REQUIRED_TEST_ENV = [
  'TEST_SUPABASE_URL',
  'EXPECTED_TEST_PROJECT_REF',
  'TEST_SUPABASE_PUBLISHABLE_KEY',
  'TEST_SUPABASE_DB_HOST',
  'TEST_SUPABASE_DB_USER',
  'TEST_SUPABASE_DB_PASSWORD',
  'TEST_IDENTITY_PASSWORD',
];

/**
 * The connection an automated suite should use.
 *
 * Post-cutover this is TEST_* and only TEST_*. Pre-cutover it falls back to the
 * DEV variables the suites have always used, and says so, so the intermediate
 * state is visible rather than implied.
 *
 * The key returned is the PUBLISHABLE key — the one an ordinary client holds,
 * which goes through Row Level Security like the browser does. The secret key
 * is not here on purpose: a suite that could reach it by accident would be a
 * suite whose RLS assertions prove nothing.
 */
export function resolveTestTarget(env = process.env) {
  const configured = Boolean(env.EXPECTED_TEST_PROJECT_REF || env.TEST_SUPABASE_URL);
  if (configured || TEST_PROJECT_REQUIRED) {
    return {
      mode: 'test',
      url: (env.TEST_SUPABASE_URL || '').replace(/\/+$/, ''),
      publishableKey: env.TEST_SUPABASE_PUBLISHABLE_KEY,
      dbUser: env.TEST_SUPABASE_DB_USER,
      dbHost: env.TEST_SUPABASE_DB_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',
      dbPassword: env.TEST_SUPABASE_DB_PASSWORD,
      identityPassword: env.TEST_IDENTITY_PASSWORD,
      expectedRef: env.EXPECTED_TEST_PROJECT_REF,
    };
  }
  return {
    mode: 'legacy-dev',
    url: (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, ''),
    publishableKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    dbUser: env.SUPABASE_DB_USER,
    dbHost: env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',
    dbPassword: env.SUPABASE_DB_PASSWORD,
    identityPassword: env.TEST_IDENTITY_PASSWORD,
    expectedRef: env.EXPECTED_TEST_PROJECT_REF,
  };
}

/**
 * The TEST secret key, for trusted setup tooling only — Auth Admin user
 * creation, and nothing else.
 *
 * Deliberately a separate call rather than a field on the target, so reaching
 * for it is a visible act. It must never be given to a client that models a
 * browser: it bypasses Row Level Security, which is the boundary these suites
 * exist to test.
 *
 * Never NEXT_PUBLIC_*, never in a bundle, a prop, a Flight payload, a log, a
 * report, or git.
 */
export function requireTestSecretKey(env = process.env) {
  const v = env.TEST_SUPABASE_SECRET_KEY;
  if (!v) {
    console.error('\nMissing TEST_SUPABASE_SECRET_KEY.\n' +
      'Only the TEST setup tooling needs it (Auth Admin user creation); it is set in\n' +
      '.env.local, which is gitignored, and its value is never printed.');
    process.exit(2);
  }
  return v;
}

/** Which of the required TEST variables are absent. Names only. */
export function missingTestEnv(env = process.env) {
  return REQUIRED_TEST_ENV.filter((n) => !env[n]);
}

/** DEV's connection, for read-only diagnostics only. Never for a suite. */
export function resolveDevTarget(env = process.env) {
  return {
    mode: 'dev-readonly',
    url: (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, ''),
    dbUser: env.SUPABASE_DB_USER,
    dbHost: env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',
    dbPassword: env.SUPABASE_DB_PASSWORD,
  };
}

// ---------------------------------------------------------------------------
// the guards suites actually call
// ---------------------------------------------------------------------------

function refuse(result, heading) {
  console.error(`\n${heading}\n\n${result.message}\n`);
  process.exit(2);
}

/**
 * Fail-closed guard for anything that writes to the database.
 * Returns the proven ref, or exits 2.
 */
export function assertTestTarget(env = process.env) {
  const t = resolveTestTarget(env);
  const r = evaluateTarget({
    url: t.url,
    expectedRef: t.expectedRef,
    safeRefs: TEST_SAFE_PROJECT_REFS,
    requireExpected: TEST_PROJECT_REQUIRED,
    env,
  });
  if (!r.ok) refuse(r, 'REFUSING TO RUN — target not proven.');
  return r.ref;
}

/**
 * Narrower guard for the reset/seed command, which empties tables.
 * Requires test-safe AND wipeable. Returns the proven ref, or exits 2.
 */
export function assertWipeTarget(env = process.env) {
  const t = resolveTestTarget(env);
  const r = evaluateTarget({
    url: t.url,
    expectedRef: t.expectedRef,
    safeRefs: TEST_SAFE_PROJECT_REFS,
    wipeableRefs: WIPEABLE_PROJECT_REFS,
    wipe: true,
    requireExpected: TEST_PROJECT_REQUIRED,
    env,
  });
  if (!r.ok) refuse(r, 'REFUSING TO WIPE — target not proven wipeable.');
  return r.ref;
}
