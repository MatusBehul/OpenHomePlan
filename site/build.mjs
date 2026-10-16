// Builds the public page in every language: site/i18n/<code>.json + site/src/page.html → site/dist/.
// English is at the root, other languages in /<code>/. No scripts, no cookies on the result.
// Run: npm run site   (then open site/dist/index.html, or serve site/dist)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dist');
const ROOT = path.join(HERE, '..');
// nginx snippets made by the build (kept out of dist so they are not served)
const CONF = path.join(HERE, 'dist-nginx');
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
  html = html.replace(/<a ((?:class="[^"]*" )?)href="((?:https?:\/\/|(?:\.\.\/)?(?:img|demo)\/)[^"]*)"/g, '<a $1href="$2" target="_blank" rel="noopener"');
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
  buildDemo();
  return codes;
}

// ---------- the online demo (/demo/) ----------
// The app itself (public/), with Three.js and the templates as static files. backend.js sees the
// meta tag and switches to demo mode: it reads demo-houses/ and refuses to save anything.
export const DEMO_HOUSES = [
  { slug: 'family-house', name: 'Family house' },
  { slug: 'manor', name: 'Small manor with a tower' },
  { slug: 'blank', name: 'Blank plot – your own idea', houseName: 'My house' },
];
const THREE_FILES = ['build/three.module.js', 'build/three.core.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/renderers/CSS2DRenderer.js', 'LICENSE'];

function buildDemo() {
  const demo = path.join(OUT, 'demo');
  fs.cpSync(path.join(ROOT, 'public'), demo, { recursive: true });
  for (const f of THREE_FILES) {
    fs.mkdirSync(path.dirname(path.join(demo, 'vendor/three', f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'node_modules/three', f), path.join(demo, 'vendor/three', f));
  }
  const index = [];
  for (const { slug, name, houseName } of DEMO_HOUSES) {
    const from = path.join(ROOT, 'examples', slug);
    const to = path.join(demo, 'demo-houses', slug);
    fs.mkdirSync(to, { recursive: true });
    const house = JSON.parse(fs.readFileSync(path.join(from, 'house.json'), 'utf8'));
    if (houseName) house.name = houseName;
    fs.writeFileSync(path.join(to, 'house.json'), JSON.stringify(house));
    if (fs.existsSync(path.join(from, 'BRIEF.md'))) fs.copyFileSync(path.join(from, 'BRIEF.md'), path.join(to, 'BRIEF.md'));
    if (fs.existsSync(path.join(from, 'assets'))) fs.cpSync(path.join(from, 'assets'), path.join(to, 'assets'), { recursive: true, filter: (f) => !f.endsWith('.gitkeep') });
    index.push({ slug, name, description: house.description || '' });
  }
  fs.writeFileSync(path.join(demo, 'demo-houses', 'index.json'), JSON.stringify(index));

  // the browser key for reading shared Google Drive folders (restricted to this site's address
  // and the Drive API, so it is fine to publish; see deploy/README.md). Without it the feature is off.
  let driveKey = '';
  let clientId = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
    driveKey = cfg.googleApiKey || '';
    clientId = cfg.googleClientId || ''; // OAuth client for comments saved to the user's Drive
  } catch {}
  if (clientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('site/config.json: googleClientId looks wrong');
  if (driveKey && !/^[\w-]{20,60}$/.test(driveKey)) throw new Error('site/config.json: googleApiKey looks wrong');
  // mark the pages as the demo, and allow exactly their import maps (the only inline scripts)
  const hashes = [];
  for (const page of ['index.html', 'print.html']) {
    const file = path.join(demo, page);
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="openhomeplan-demo" content="1">${driveKey ? `\n  <meta name="openhomeplan-drive-key" content="${driveKey}">` : ''}${clientId ? `\n  <meta name="openhomeplan-google-client" content="${clientId}">` : ''}`);
    const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (!map) throw new Error(`demo/${page}: no import map found`);
    hashes.push(`'sha256-${createHash('sha256').update(map[1]).digest('base64')}'`);
    fs.writeFileSync(file, html);
  }
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline'", // the app sets inline styles on generated elements
    // Google's Drive API only when a shared folder is opened (files and textures are read from it)
    `img-src 'self' data: blob:${driveKey ? ' https://www.googleapis.com' : ''}`,
    `connect-src 'self'${driveKey ? ' https://www.googleapis.com' : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const headers = fs
    .readFileSync(path.join(ROOT, 'deploy/site/security-headers.conf'), 'utf8')
    .replace(/add_header Content-Security-Policy "[^"]*"/, `add_header Content-Security-Policy "${csp}"`)
    // the key only works with the site's address as referrer: send the origin, never the page
    .replace(/add_header Referrer-Policy "[^"]*"/, 'add_header Referrer-Policy "strict-origin"');
  fs.rmSync(CONF, { recursive: true, force: true });
  fs.mkdirSync(CONF, { recursive: true });
  fs.writeFileSync(path.join(CONF, 'demo-headers.conf'), headers);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('built', build().join(', '), '→', OUT);
