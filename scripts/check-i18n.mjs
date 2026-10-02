// Every literal passed to t("…") must have a Simplified Chinese entry.
//
// The English text is the key (lib/i18n/core.ts), so a missing entry does not
// break anything — it silently shows English inside a Chinese page. This finds
// those before a user does: it collects every t("literal") / t('literal') in
// app/, components/ and lib/, and every key in lib/i18n/zh/*.ts, and prints
// the literals with no translation. Dynamic keys (t(variable)) cannot be
// checked statically and are counted separately so they stay visible.
//
// Run: npm run i18n:check

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const STR = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
const unquote = (lit) => (lit.startsWith("'")
  ? JSON.parse(`"${lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`)
  : JSON.parse(lit));

const keys = new Set();
for (const f of walk(join(ROOT, 'lib/i18n/zh'))) {
  for (const m of readFileSync(f, 'utf8').matchAll(new RegExp(String.raw`^\s*${STR}\s*:`, 'gm'))) {
    keys.add(unquote(m[1]));
  }
}

const missing = new Map();
let dynamic = 0;
for (const dir of ['app', 'components', 'lib']) {
  for (const f of walk(join(ROOT, dir))) {
    if (f.includes(join('lib', 'i18n'))) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*${STR}`, 'g'))) {
      const key = unquote(m[1]);
      if (!keys.has(key)) {
        const where = relative(ROOT, f).replace(/\\/g, '/');
        missing.set(key, [...(missing.get(key) ?? []), where]);
      }
    }
    dynamic += [...src.matchAll(/\bt\(\s*[A-Za-z_`]/g)].length;
  }
}

console.log(`${keys.size} zh entries; ${missing.size} literal key(s) missing; ${dynamic} dynamic t(…) call(s) not checkable`);
for (const [key, files] of missing) console.log(`  MISSING ${JSON.stringify(key)}  <- ${[...new Set(files)].join(', ')}`);
process.exit(missing.size ? 1 : 0);
