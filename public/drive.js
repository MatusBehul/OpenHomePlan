// Read-only houses from a Google Drive folder shared as "anyone with the link can view", for the
// online demo. The folder holds house folders (each with house.json, assets/, comments/, BRIEF.md)
// or is one house folder itself. Uses the Drive API with the site's browser key (restricted to
// the site's address); nothing is written.
const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

export const driveKey = () => (typeof document !== 'undefined' && document.querySelector('meta[name="openhomeplan-drive-key"]')?.content) || '';

// The folder id from a share link (…/folders/<id>, …?id=<id>) or a bare id.
export function folderIdFrom(text) {
  const s = String(text || '').trim();
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/^([\w-]{10,})$/);
  return m ? m[1] : null;
}

async function api(url) {
  const res = await fetch(url, { cache: 'no-store', referrerPolicy: 'strict-origin' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const why = data.error?.message || res.statusText;
    throw new Error(res.status === 404 ? 'Google Drive: folder or file not found. Is it shared as “Anyone with the link can view”?' : `Google Drive: ${why}`);
  }
  return res;
}

async function children(id) {
  const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
  const out = [];
  let page = '';
  do {
    const res = await api(`${API}?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? `&pageToken=${page}` : ''}&key=${driveKey()}`);
    const data = await res.json();
    out.push(...data.files);
    page = data.nextPageToken || '';
  } while (page);
  return out;
}

export const fileUrl = (id) => `${API}/${id}?alt=media&supportsAllDrives=true&key=${driveKey()}`;
const text = async (id) => (await api(fileUrl(id))).text();

// house folder id → { files: Map(name → file), assets: Map(name → id), json }
const houses = new Map();

async function readHouseFolder(id, list, name = null) {
  const files = new Map((list || (await children(id))).map((f) => [f.name, f]));
  const hj = files.get('house.json');
  if (!hj || hj.mimeType === FOLDER) return null;
  if (!name) name = (await (await api(`${API}/${id}?fields=name&supportsAllDrives=true&key=${driveKey()}`)).json()).name;
  const entry = { id, name, files, assets: new Map(), json: JSON.parse(await text(hj.id)) };
  const assets = files.get('assets');
  if (assets?.mimeType === FOLDER) for (const f of await children(assets.id)) entry.assets.set(f.name, f.id);
  houses.set(id, entry);
  return entry;
}

// The houses in a shared folder: [{ slug (the house folder's id), name, description }].
export async function listHouses(folderId) {
  const list = await children(folderId);
  const own = await readHouseFolder(folderId, list);
  const entries = own ? [own] : (await Promise.all(list.filter((f) => f.mimeType === FOLDER).map((f) => readHouseFolder(f.id, null, f.name).catch(() => null)))).filter(Boolean);
  if (!entries.length) throw new Error('Google Drive: no house.json found in this folder or its sub-folders.');
  const names = new Map(list.map((f) => [f.id, f.name]));
  return entries
    .map((e) => ({ slug: e.id, name: e.json.name || names.get(e.id) || 'House', description: e.json.description || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function house(id) {
  return houses.get(id) || readHouseFolder(id);
}

export async function houseJson(id) {
  return (await house(id)).json;
}

export async function brief(id) {
  const f = (await house(id)).files.get('BRIEF.md');
  return { text: f ? await text(f.id) : '' };
}

// Comments as the local server lists them (read-only here).
export async function comments(id) {
  const h = await house(id);
  const dir = h.files.get('comments');
  if (!dir || dir.mimeType !== FOLDER) return [];
  const out = [];
  for (const sub of await children(dir.id)) {
    if (sub.mimeType !== FOLDER || !['open', 'resolved'].includes(sub.name)) continue;
    for (const f of (await children(sub.id)).filter((x) => x.name.endsWith('.md'))) out.push(parseComment(await text(f.id), f.name, sub.name));
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

function parseComment(src, name, status) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*?)\s*(#.*)?$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return {
    id: meta.id || name.replace(/\.md$/, ''),
    target: meta.target || 'house',
    target_name: meta.target_name || meta.target || 'Whole house',
    status: meta.status || status,
    created: meta.created || null,
    folder: status,
    file: `comments/${status}/${name}`,
    body: (m ? m[2] : src).trim(),
  };
}

// The Drive folder name of a house (the local planner matches comments to houses by it).
export const folderName = (id) => houses.get(id)?.name || '';

// URL of a house file such as "assets/tiles.jpg" (house must have been read already).
export function houseFileUrl(id, file) {
  const name = String(file).replace(/^assets\//, '');
  const fid = houses.get(id)?.assets.get(name);
  return fid ? fileUrl(fid) : '';
}
