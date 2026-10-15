// Every browser module must at least parse. `node --check` on a .js file in a package without
// "type": "module" doesn't check ES module syntax, so each file is checked as a .mjs copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-syntax-'));

for (const file of fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js'))) {
  test(`public/${file} parses`, () => {
    const copy = path.join(tmp, file.replace(/\.js$/, '.mjs'));
    fs.copyFileSync(path.join(ROOT, 'public', file), copy);
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }));
  });
}
test('server.js parses', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(ROOT, 'server.js')], { stdio: 'pipe' }));
});
