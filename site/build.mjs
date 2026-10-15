// Builds the public page in every language: site/i18n/<code>.json + site/src/page.html → site/dist/.
// English is at the root, other languages in /<code>/. No scripts, no cookies on the result.
// Run: npm run site   (then open site/dist/index.html, or serve site/dist)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dist');
export const SITE = 'https://openhomeplan.wadby.tech/';
export const REPO = 'https://github.com/MatusBehul/OpenHomePlan';
// menu order; any other file in i18n/ is added after these
const ORDER = ['en', 'cs', 'sk', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'uk'];
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export function languages() {
  const codes = fs.readdirSync(path.join(HERE, 'i18n')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  return [...ORDER.filter((c) => codes.includes(c)), ...codes.filter((c) => !ORDER.includes(c)).sort()];
}
export const load = (code) => JSON.parse(fs.readFileSync(path.join(HERE, 'i18n', `${code}.json`), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function render(code, all) {
  const en = all.en;
  const t = { ...en, ...all[code] }; // anything not translated yet falls back to English
  const root = code === 'en' ? '' : '../';
  const url = SITE + (code === 'en' ? '' : `${code}/`);
  const href = (c) => (c === 'en' ? `${root}./` : `${root}${c}/`).replace('../.', '..');
  const alternates = [
    ...Object.keys(all).map((c) => `  <link rel="alternate" hreflang="${c}" href="${SITE}${c === 'en' ? '' : `${c}/`}">`),
    `  <link rel="alternate" hreflang="x-default" href="${SITE}">`,
  ].join('\n');
  const menu = Object.keys(all)
    .map((c) => `          <li><a href="${href(c)}" lang="${c}" hreflang="${c}"${c === code ? ' aria-current="page"' : ''}>${esc(all[c].langName)}</a></li>`)
    .join('\n');
  let html = fs.readFileSync(path.join(HERE, 'src', 'page.html'), 'utf8');
  html = html
    .replace('{{alternates}}', alternates)
    .replace('{{languages}}', menu)
    .replace(/\{\{list:([\w.]+)\}\}/g, (_, k) => (t[k] || []).map((item) => `<li>${item}</li>`).join(''))
    .replace(/\{\{(meta\.[\w.]+|alt\.[\w.]+|nav\.language|how\.treeLabel|shots\.label)\}\}/g, (_, k) => esc(t[k] ?? '')) // attributes
    .replace(/\{\{([\w.]+)\}\}/g, (m, k) => {
      const vars = { lang: code, dir: RTL.has(code) ? 'rtl' : 'ltr', root, url, site: SITE, repo: REPO, locale: t.locale || code };
      if (k in vars) return vars[k];
      return k in t ? t[k] : m;
    })
    // strings may themselves use {{repo}} / {{root}}
    .replace(/\{\{repo\}\}/g, REPO)
    .replace(/\{\{root\}\}/g, root)
    .replace(/<p class="small"><\/p>/g, '');
  // links that leave the page open in a new tab
  html = html.replace(/<a ((?:class="[^"]*" )?)href="((?:https?:\/\/|(?:\.\.\/)?img\/)[^"]*)"/g, '<a $1href="$2" target="_blank" rel="noopener"');
  const missing = [...html.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
  if (missing.length) throw new Error(`${code}: unfilled ${[...new Set(missing)].join(', ')}`);
  return html;
}

export function build() {
  const codes = languages();
  const all = Object.fromEntries(codes.map((c) => [c, load(c)]));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const code of codes) {
    const dir = code === 'en' ? OUT : path.join(OUT, code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), render(code, all));
  }
  fs.copyFileSync(path.join(HERE, 'style.css'), path.join(OUT, 'style.css'));
  fs.cpSync(path.join(HERE, 'img'), path.join(OUT, 'img'), { recursive: true });
  return codes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('built', build().join(', '), '→', OUT);
