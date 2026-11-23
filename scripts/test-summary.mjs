// Runs the test suite, parses node:test's TAP output, and writes a small JSON
// summary that the README's "tests" badge reads via shields.io. Exits non-zero
// if any test fails, so CI fails too.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' });
const out = (res.stdout || '') + (res.stderr || '');
process.stdout.write(out);

const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
const tests = num(/# tests (\d+)/);
const pass = num(/# pass (\d+)/);
const fail = num(/# fail (\d+)/);

const summary = {
  schemaVersion: 1,
  label: 'tests',
  message: fail ? `${pass}/${tests} passing` : `${pass} passing`,
  color: fail ? 'red' : 'brightgreen',
  tests, passing: pass, failing: fail,
  generatedAt: new Date().toISOString(),
};
mkdirSync(path.join(root, 'docs', 'assets'), { recursive: true });
writeFileSync(path.join(root, 'docs', 'assets', 'test-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`\ntest-summary: ${summary.message}`);
process.exit(fail ? 1 : 0);
