// Run the app against the TEST project.
//
// The browser suites drive a real server, and that server connects to whatever
// NEXT_PUBLIC_SUPABASE_URL names -- which in .env.local is DEV, the owner's
// data. Pointing the suites at a TEST database while the app they drive still
// talks to DEV would mean every UI write landing in DEV: the separation would
// be real for the direct-database suites and fiction for the browser ones.
//
// So map TEST_* onto the NEXT_PUBLIC_* names the app reads, in the child
// process only. Nothing is written to .env.local and no value reaches the
// command line, where it would show up in a process listing.
//
// The PUBLISHABLE key is used, never the secret one. The app is a browser
// client and must go through RLS exactly as a browser does; handing it a key
// that bypasses RLS would make every privacy assertion in the browser suites
// meaningless.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvLocal, resolveDeclaredTestProject } from '../supabase/tests/lib/target.mjs';

loadEnvLocal();

let target;
try {
  target = resolveDeclaredTestProject();
} catch (e) {
  console.error(`\n${e.message}\n`);
  process.exit(2);
}

const port = process.env.PORT || '3101';
console.log(`TEST app server on http://127.0.0.1:${port}`);
console.log(`  project ${target.ref}`);
console.log(`  key: publishable (RLS applies, as in a browser)\n`);

// Run Next's own entry with this Node, rather than the npx/next shim. Spawning
// a .cmd without a shell is EINVAL on Windows, and turning the shell on to fix
// that would put every argument through cmd's quoting rules.
const nextBin = resolve(dirname(fileURLToPath(import.meta.url)), '..',
  'node_modules/next/dist/bin/next');

const child = spawn(
  process.execPath,
  [nextBin, 'dev', '--webpack', '-p', port, '-H', '127.0.0.1'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: target.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: target.publishableKey,
      // Not inherited into the app: it has no use for a key that bypasses RLS.
      SUPABASE_SERVICE_ROLE_KEY: '',
      TEST_SUPABASE_SECRET_KEY: '',
    },
  });
child.on('exit', (c) => process.exit(c ?? 0));
