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
  ['security-regression', 'Security / identity isolation'],
  ['appointment-engine-regression', 'Appointment engine scheduling rules'],
  ['cross-workspace-privacy-regression', 'Cross-workspace privacy'],
];

const results = [];
for (const [file, label] of SUITES) {
  console.log(`\n${'='.repeat(72)}\n>>> ${label}\n${'='.repeat(72)}`);
  const code = await new Promise(done => {
    const p = spawn(process.execPath, [resolve(HERE, `${file}.mjs`)], { stdio: 'inherit' });
    p.on('close', done);
  });
  results.push({ file, label, code });
}

console.log(`\n${'='.repeat(72)}\nREGRESSION SUITE VERDICT\n${'='.repeat(72)}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.label}  (${r.file})`);
}
const failed = results.filter(r => r.code !== 0);
console.log(failed.length ? `\n${failed.length} suite(s) FAILED` : '\nAll suites passed.');
process.exit(failed.length ? 1 : 0);
