// Runs every regression suite in sequence and prints a combined verdict.
// Each suite is a separate process so one suite's fixture teardown can never
// be skipped by another suite's failure.
//
// Run: npm run test:regression

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['cleanup-safety-regression', 'Cleanup safety / data isolation'],
  ['security-regression', 'Security / identity isolation'],
  ['appointment-engine-regression', 'Appointment engine scheduling rules'],
  ['cross-workspace-privacy-regression', 'Cross-workspace privacy'],
  ['availability-finder-regression', 'Availability finder (0006 + 0007)'],
  ['past-guard-and-config-regression', 'Past-datetime guard + booking config (0007)'],
  ['working-hours-boundary-regression', 'Working-hours midnight boundary (0008)'],
  ['past-appointment-recording-regression', 'Past appointment recording (0010)'],
  ['error-mapping-coverage-regression', 'Privacy-safe error mapping coverage'],
];

const results = [];
for (const [file, label] of SUITES) {
  console.log(`\n${'='.repeat(72)}\n>>> ${label}\n${'='.repeat(72)}`);
  // Output is echoed AND captured: a skipped check is not a failure, so it
  // cannot show up in the exit code, and a verdict that only reads exit codes
  // would report "All suites passed" while a property went unexercised.
  let out = '';
  const code = await new Promise(done => {
    const p = spawn(process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', resolve(HERE, `${file}.mjs`)],
      { stdio: ['inherit', 'pipe', 'pipe'] });
    for (const stream of [p.stdout, p.stderr]) {
      stream.on('data', chunk => { out += chunk; process.stdout.write(chunk); });
    }
    p.on('close', done);
  });
  const skipped = Number(/\/ (\d+) SKIPPED/.exec(out)?.[1] ?? 0);
  results.push({ file, label, code, skipped });
}

console.log(`\n${'='.repeat(72)}\nREGRESSION SUITE VERDICT\n${'='.repeat(72)}`);
for (const r of results) {
  const skips = r.skipped ? `  [${r.skipped} SKIPPED]` : '';
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.label}  (${r.file})${skips}`);
}
const failed = results.filter(r => r.code !== 0);
const skippedTotal = results.reduce((n, r) => n + r.skipped, 0);
console.log(failed.length ? `\n${failed.length} suite(s) FAILED` : '\nAll suites passed.');
if (skippedTotal) {
  console.log(`${skippedTotal} check(s) were SKIPPED and are NOT counted as passes — ` +
    `see the [SKIP] lines above for why.`);
}
process.exit(failed.length ? 1 : 0);
