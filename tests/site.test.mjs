import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { languages, load, build } from '../site/build.mjs';

const en = load('en');

test('every translation has the same keys as en.json', () => {
  for (const code of languages()) {
    if (code === 'en') continue;
    const t = load(code);
    for (const [key, value] of Object.entries(en)) {
      if (key === 'footer.translation') continue;
      assert.ok(key in t, `${code}.json is missing "${key}"`);
      if (Array.isArray(value)) {
        assert.equal(t[key].length, value.length, `${code}.json "${key}" should have ${value.length} items`);
      }
    }
    for (const key of Object.keys(t)) assert.ok(key in en, `${code}.json has unknown key "${key}"`);
  }
});

test('the public page builds in every language', () => {
  const dir = new URL('../site/dist', import.meta.url).pathname;
  for (const code of build()) {
    const html = readFileSync(`${dir}/${code === 'en' ? '' : code + '/'}index.html`, 'utf8');
    assert.match(html, new RegExp(`<html lang="${code}"`));
    assert.doesNotMatch(html, /\{\{/);
    assert.doesNotMatch(html, /<a (?:class="[^"]*" )?href="https?:[^"]*"(?! target)/, 'external links open in a new tab');
  }
});
