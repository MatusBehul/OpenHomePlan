// House planner server: serves the app and manages a folder of houses. Each house is
// its own folder (house.json, comments/, assets/) and its own git repository, so every
// save and comment is versioned per house. No dependencies besides Node itself.
//
// Where houses live: HOUSES_DIR env var, else "housesDir" in planner.config.json, else
// ./houses. Point it at a synced folder (Google Drive, Dropbox, iCloud...) to keep your
// houses in the cloud.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const FALLBACK_IDENTITY = ['-c', 'user.name=OpenHomePlan', '-c', 'user.email=openhomeplan@localhost'];
const EXAMPLES_DIR = path.join(ROOT, 'examples');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET = /^[\w.-]{1,120}\.(png|jpe?g|webp|gif)$/i;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'planner.config.json'), 'utf8'));
  } catch {
    return {};
  }
}
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const HOUSES_DIR = path.resolve(ROOT, expandHome(process.env.HOUSES_DIR || loadConfig().housesDir || 'houses'));

const STATIC = {
  '/': path.join(ROOT, 'public'),
  '/vendor/three/': path.join(ROOT, 'node_modules', 'three'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// ---------- git (one repository per house) ----------

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message += `\n${stderr}`;
        reject(err);
      } else resolve(stdout);
    });
  });
}

async function hasIdentity(cwd) {
  try {
    const name = (await git(cwd, ['config', 'user.name'])).trim();
    const email = (await git(cwd, ['config', 'user.email'])).trim();
    return Boolean(name && email);
  } catch {
    return false;
  }
}

async function ensureRepo(dir) {
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    if (fs.realpathSync(top) === fs.realpathSync(dir)) return;
  } catch {}
  // not a repository of its own yet (or nested inside another one): make it one
  await git(dir, ['init', '-q']);
}

// Serialize git operations so concurrent saves can't collide on the index lock.
let gitQueue = Promise.resolve();
function commit(dir, paths, message) {
  const run = async () => {
    await ensureRepo(dir);
    await git(dir, ['add', '-A', '--', ...paths]);
    const staged = await git(dir, ['diff', '--cached', '--name-only', '--', ...paths]);
    if (!staged.trim()) return null;
    const identity = (await hasIdentity(dir)) ? [] : FALLBACK_IDENTITY;
    await git(dir, [...identity, 'commit', '-q', '-m', message, '--', ...paths]);
    return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
  };
  const result = gitQueue.then(run, run);
  gitQueue = result.catch(() => {});
  return result;
}

// ---------- houses ----------

function houseDir(slug) {
  if (!SLUG.test(slug)) throw new Error(`invalid house "${slug}"`);
  return path.join(HOUSES_DIR, slug);
}

async function listHouses() {
  await fsp.mkdir(HOUSES_DIR, { recursive: true });
  const out = [];
  for (const entry of await fsp.readdir(HOUSES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
    const file = path.join(HOUSES_DIR, entry.name, 'house.json');
    try {
      const [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
      const h = JSON.parse(text);
      out.push({ slug: entry.name, name: h.name || entry.name, description: h.description || '', updated: stat.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listTemplates() {
  const out = [];
  try {
    for (const entry of await fsp.readdir(EXAMPLES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const house = JSON.parse(await fsp.readFile(path.join(EXAMPLES_DIR, entry.name, 'house.json'), 'utf8'));
        out.push({ id: entry.name, name: house.name || entry.name, description: house.description || '' });
      } catch {}
    }
  } catch {}
  return out;
}

async function copyDir(from, to, skip = new Set(['.git'])) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(a, b, skip);
    else await fsp.copyFile(a, b);
  }
}

function slugify(s) {
  return (
    String(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'house'
  );
}

// Create a house from a template (examples/<id>) or by duplicating another house.
async function createHouse({ name, template, duplicate }) {
  name = oneLine(name || '').slice(0, 80);
  if (!name) throw new Error('invalid name: a house needs a name');
  let slug = slugify(name);
  for (let n = 2; fs.existsSync(path.join(HOUSES_DIR, slug)); n++) slug = `${slugify(name)}-${n}`;
  const dir = houseDir(slug);
  const source = duplicate ? houseDir(duplicate) : path.join(EXAMPLES_DIR, template || 'blank');
  if (!fs.existsSync(path.join(source, 'house.json'))) throw new Error('invalid template or house to copy from');
  await copyDir(source, dir, new Set(['.git', ...(duplicate ? [] : [])]));
  for (const sub of ['comments/open', 'comments/resolved', 'assets']) await fsp.mkdir(path.join(dir, sub), { recursive: true });
  for (const sub of ['comments/open', 'comments/resolved', 'assets']) {
    const keep = path.join(dir, sub, '.gitkeep');
    if (!fs.existsSync(keep)) await fsp.writeFile(keep, '');
  }
  const file = path.join(dir, 'house.json');
  const house = JSON.parse(await fsp.readFile(file, 'utf8'));
  house.name = name;
  await fsp.writeFile(file, JSON.stringify(house, null, 2) + '\n');
  await commit(dir, ['.'], duplicate ? `Create ${name} as a copy of ${duplicate}` : `Create ${name} from the ${template || 'blank'} template`);
  return { slug, name };
}

// First run: an empty houses folder gets the example house so there is something to open.
async function seedHouses() {
  await fsp.mkdir(HOUSES_DIR, { recursive: true });
  if ((await listHouses()).length) return;
  if (fs.existsSync(path.join(EXAMPLES_DIR, 'family-house', 'house.json'))) {
    const { slug } = await createHouse({ name: 'Family house', template: 'family-house' });
    console.log(`Created your first house from the example: ${path.join(HOUSES_DIR, slug)}`);
  }
}

function validateHouse(house) {
  if (!house || typeof house !== 'object') return 'house must be an object';
  if (!Array.isArray(house.floors) || !house.floors.length) return 'house.floors must be a non-empty array';
  if (!Array.isArray(house.site)) return 'house.site must be an array';
  const floorIds = new Set();
  for (const floor of house.floors) {
    if (!floor.id || floorIds.has(floor.id) || !Array.isArray(floor.rooms)) return 'every floor needs a unique id and rooms';
    floorIds.add(floor.id);
    const ids = new Set();
    for (const r of floor.rooms) {
      if (!r.id || ids.has(r.id)) return `duplicate or missing room id "${r.id}" on ${floor.id}`;
      ids.add(r.id);
      for (const k of ['x', 'y', 'w', 'h']) {
        if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) return `room ${floor.id}/${r.id}: ${k} must be a number`;
      }
      if (r.w <= 0 || r.h <= 0) return `room ${floor.id}/${r.id} must have positive size`;
    }
    for (const item of [...(floor.doors || []), ...(floor.openings || []), ...(floor.items || []), ...(floor.points || [])]) {
      if (!item.id || ids.has(item.id)) return `duplicate or missing id "${item.id}" on ${floor.id}`;
      ids.add(item.id);
    }
  }
  return null;
}

// ---------- comments ----------

function parseComment(text, file, status, dir) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = text;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*?)\s*(#.*)?$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
    body = m[2];
  }
  return {
    id: meta.id || path.basename(file, '.md'),
    target: meta.target || 'house',
    target_name: meta.target_name || meta.target || 'Whole house',
    status: meta.status || status,
    created: meta.created || null,
    folder: status,
    file: path.relative(dir, file),
    body: body.trim(),
  };
}

async function listComments(dir) {
  const out = [];
  for (const status of ['open', 'resolved']) {
    const folder = path.join(dir, 'comments', status);
    let files = [];
    try {
      files = await fsp.readdir(folder);
    } catch {}
    for (const f of files.filter((f) => f.endsWith('.md')).sort()) {
      const full = path.join(folder, f);
      out.push(parseComment(await fsp.readFile(full, 'utf8'), full, status, dir));
    }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

function localIsoWithOffset(d) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

async function createComment(dir, { target, target_name, text }) {
  target = oneLine(target || 'house');
  if (!/^(house|roof|site\/[\w-]+|[\w-]+\/[\w:-]+)$/.test(target)) throw new Error(`invalid target "${target}"`);
  if (!text || !String(text).trim()) throw new Error('comment text is empty');
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const base = `${stamp}-${slugify(target)}`;
  const openDir = path.join(dir, 'comments', 'open');
  const resolvedDir = path.join(dir, 'comments', 'resolved');
  await fsp.mkdir(openDir, { recursive: true });
  let id = base;
  for (let n = 2; fs.existsSync(path.join(openDir, `${id}.md`)) || fs.existsSync(path.join(resolvedDir, `${id}.md`)); n++) id = `${base}-${n}`;
  const file = path.join(openDir, `${id}.md`);
  const content =
    `---\nid: ${id}\ntarget: ${target}\ntarget_name: ${oneLine(target_name || target)}\n` +
    `status: open\ncreated: ${localIsoWithOffset(now)}\n---\n\n${String(text).trim()}\n`;
  await fsp.writeFile(file, content, { flag: 'wx' });
  const hash = await commit(dir, [path.relative(dir, file)], `Comment ${id} on ${oneLine(target_name || target)}`);
  return { comment: parseComment(content, file, 'open', dir), commit: hash };
}

// ---------- comments from the online demo ----------

// Comments written in the online demo are saved to the commenter's Google Drive, in a folder
// "OpenHomePlan comments". Google Drive on this computer syncs that folder; here we move each one
// into its house's comments/open/ (matched by the house's folder name) and commit it.
const INBOX_NAME = 'OpenHomePlan comments';
function commentInboxes() {
  const configured = process.env.COMMENTS_INBOX || loadConfig().commentsInbox;
  if (configured) return [path.resolve(ROOT, expandHome(configured))];
  // Google Drive for desktop on macOS: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive/
  const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
  let accounts = [];
  try {
    accounts = fs.readdirSync(cloud).filter((d) => d.startsWith('GoogleDrive-'));
  } catch {}
  return accounts.map((a) => path.join(cloud, a, 'My Drive', INBOX_NAME)).filter((d) => fs.existsSync(d));
}

let importing = false;
async function importComments() {
  if (importing) return;
  importing = true;
  try {
    for (const inbox of commentInboxes()) {
      let files = [];
      try {
        files = (await fsp.readdir(inbox)).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      for (const f of files) {
        const full = path.join(inbox, f);
        try {
          const text = await fsp.readFile(full, 'utf8');
          const meta = parseComment(text, full, 'open', inbox);
          const fm = Object.fromEntries([...(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '').matchAll(/^([\w-]+):\s*(.*?)\s*$/gm)].map((m) => [m[1], m[2]]));
          // the house: its folder name, else a house with the same name
          let slug = SLUG.test(fm.house_folder || '') && fs.existsSync(path.join(HOUSES_DIR, fm.house_folder, 'house.json')) ? fm.house_folder : null;
          if (!slug && fm.house_name) slug = (await listHouses()).find((h) => h.name === fm.house_name)?.slug || null;
          if (!slug) {
            console.log(`Comment ${f} in ${inbox}: no house "${fm.house_folder || fm.house_name}" here; left in the inbox.`);
            continue;
          }
          const dir = houseDir(slug);
          const openDir = path.join(dir, 'comments', 'open');
          await fsp.mkdir(openDir, { recursive: true });
          let id = SLUG.test(meta.id) ? meta.id : `${Date.now()}`;
          for (let n = 2; fs.existsSync(path.join(openDir, `${id}.md`)) || fs.existsSync(path.join(dir, 'comments', 'resolved', `${id}.md`)); n++) id = `${meta.id}-${n}`;
          // keep the comment as the planner writes them, noting who wrote it and from where
          const content =
            `---\nid: ${id}\ntarget: ${oneLine(meta.target)}\ntarget_name: ${oneLine(meta.target_name)}\nstatus: open\ncreated: ${oneLine(meta.created || localIsoWithOffset(new Date()))}\n` +
            (fm.author ? `author: ${oneLine(fm.author)}\n` : '') +
            `source: online demo\n---\n\n${meta.body}\n`;
          const target = path.join(openDir, `${id}.md`);
          await fsp.writeFile(target, content, { flag: 'wx' });
          await commit(dir, [path.relative(dir, target)], `Comment ${id} on ${oneLine(meta.target_name)} (from the online demo${fm.author ? `, ${oneLine(fm.author)}` : ''})`);
          await fsp.unlink(full);
          console.log(`Imported comment ${id} into ${slug} (from ${inbox}).`);
        } catch (err) {
          console.log(`Comment ${f}: could not import: ${err.message}`);
        }
      }
    }
  } finally {
    importing = false;
  }
}

// ---------- exchange rates ----------

// Euro foreign exchange reference rates from the European Central Bank (base EUR, updated on
// working days around 16:00 CET). Cached for an hour in memory and kept on disk as a fallback.
const ECB_URL = process.env.ECB_URL || 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const RATES_CACHE = path.join(ROOT, 'rates-cache.json');
let ratesMemo = null;

async function exchangeRates(refresh) {
  if (!refresh && ratesMemo && Date.now() - ratesMemo.fetched < 3600e3) return ratesMemo.data;
  try {
    const res = await fetch(ECB_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`ECB answered ${res.status}`);
    const xml = await res.text();
    const date = (xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/) || [])[1];
    const values = {};
    for (const [, cur, rate] of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) values[cur] = Number(rate);
    if (!date || !Object.keys(values).length) throw new Error('unexpected answer from the ECB');
    const data = { base: 'EUR', date, source: 'European Central Bank reference rates', values };
    ratesMemo = { fetched: Date.now(), data };
    await fsp.writeFile(RATES_CACHE, JSON.stringify(data, null, 2) + '\n').catch(() => {});
    return data;
  } catch (err) {
    try {
      const cached = JSON.parse(await fsp.readFile(RATES_CACHE, 'utf8'));
      return { ...cached, stale: true, error: err.message };
    } catch {
      throw new Error(`could not download exchange rates (${err.message})`);
    }
  }
}

// ---------- http ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('invalid upload: request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req) => JSON.parse((await readBody(req)).toString('utf8'));

async function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

async function serveStatic(req, res, pathname) {
  const prefix = Object.keys(STATIC)
    .filter((p) => pathname.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  let rel = decodeURIComponent(pathname.slice(prefix.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  return serveFile(res, STATIC[prefix], rel);
}

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, { housesDir: HOUSES_DIR, templates: await listTemplates() });
    }
    if (pathname === '/api/houses' && req.method === 'GET') return send(res, 200, await listHouses());
    if (pathname === '/api/rates' && req.method === 'GET') {
      try {
        return send(res, 200, await exchangeRates(searchParams.get('refresh') === '1'));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    if (pathname === '/api/houses' && req.method === 'POST') return send(res, 201, await createHouse(await readJson(req)));

    const m = pathname.match(/^\/(api\/)?houses\/([^/]+)\/(.*)$/);
    if (m) {
      const dir = houseDir(decodeURIComponent(m[2]));
      if (!fs.existsSync(path.join(dir, 'house.json'))) return send(res, 404, { error: 'no such house' });
      const rest = m[3];
      const api = Boolean(m[1]);
      // uploaded images (tile textures etc.)
      if (!api && rest.startsWith('assets/') && req.method === 'GET') return serveFile(res, path.join(dir, 'assets'), decodeURIComponent(rest.slice(7)));
      if (api && rest === 'house' && req.method === 'GET') return send(res, 200, await fsp.readFile(path.join(dir, 'house.json'), 'utf8'));
      if (api && rest === 'house' && req.method === 'PUT') {
        const { house, message } = await readJson(req);
        const error = validateHouse(house);
        if (error) return send(res, 400, { error });
        await fsp.writeFile(path.join(dir, 'house.json'), JSON.stringify(house, null, 2) + '\n');
        const hash = await commit(dir, ['house.json'], oneLine(message || 'Update house plan'));
        return send(res, 200, { ok: true, commit: hash });
      }
      if (api && rest === 'brief' && req.method === 'GET') {
        let text = '';
        try {
          text = await fsp.readFile(path.join(dir, 'BRIEF.md'), 'utf8');
        } catch {}
        return send(res, 200, { text });
      }
      if (api && rest === 'comments' && req.method === 'GET') return send(res, 200, await listComments(dir));
      if (api && rest === 'comments' && req.method === 'POST') return send(res, 201, await createComment(dir, await readJson(req)));
      if (api && rest === 'assets' && req.method === 'POST') {
        const original = path.basename(String(searchParams.get('name') || ''));
        if (!ASSET.test(original)) throw new Error('invalid upload: use a .png, .jpg, .webp or .gif image');
        const data = await readBody(req, 15 * 1024 * 1024);
        if (!data.length) throw new Error('invalid upload: empty file');
        const assets = path.join(dir, 'assets');
        await fsp.mkdir(assets, { recursive: true });
        const ext = path.extname(original).toLowerCase();
        const stem = slugify(path.basename(original, ext));
        let name = `${stem}${ext}`;
        for (let n = 2; fs.existsSync(path.join(assets, name)); n++) name = `${stem}-${n}${ext}`;
        await fsp.writeFile(path.join(assets, name), data);
        const hash = await commit(dir, [`assets/${name}`], `Add texture ${name}`);
        return send(res, 201, { file: `assets/${name}`, commit: hash });
      }
      if (api && rest === 'history' && req.method === 'GET') {
        const n = Math.min(Number(searchParams.get('n')) || 25, 200);
        let log = '';
        try {
          await ensureRepo(dir);
          log = await git(dir, ['log', `-n${n}`, '--date=iso-strict', '--pretty=format:%h%x1f%ad%x1f%an%x1f%s']);
        } catch {} // no commits yet
        const entries = log
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [hash, date, author, subject] = l.split('\x1f');
            return { hash, date, author, subject };
          });
        return send(res, 200, entries);
      }
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res, pathname);
  } catch (err) {
    const status = err instanceof SyntaxError || /invalid|empty/.test(err.message) ? 400 : 500;
    if (status === 500) console.error(err);
    return send(res, status, { error: err.message });
  }
}

// `node server.js --import-comments <folder>`: import comment files from a folder once and exit
// (e.g. files fetched from the "OpenHomePlan comments" folder in Google Drive).
const importAt = process.argv.indexOf('--import-comments');
if (importAt > 0) {
  const from = process.argv[importAt + 1];
  if (!from || !fs.existsSync(from)) {
    console.error('Usage: npm run import-comments -- <folder with comment .md files>');
    process.exit(1);
  }
  process.env.COMMENTS_INBOX = path.resolve(from);
  importComments().then(() => process.exit(0));
} else seedHouses()
  .catch((err) => console.warn('Could not prepare the houses folder:', err.message))
  .then(() => {
    http.createServer(handle).listen(PORT, '127.0.0.1', () => {
      console.log(`House planner running at http://localhost:${PORT}`);
      console.log(`Houses folder: ${HOUSES_DIR}`);
      const inboxes = commentInboxes();
      if (inboxes.length) console.log(`Comments from the online demo: ${inboxes.join(', ')}`);
      importComments();
      setInterval(importComments, 20_000).unref();
    });
  });
