// Where the app gets its data. Normally that is the local server (npm start). The online demo
// (built by site/build.mjs) is plain static files: the templates are read from demo-houses/ and
// everything that would write (saving, comments, uploads) is refused with DEMO_NOTICE.
import * as drive from './drive.js';

export const DEMO = typeof document !== 'undefined' && !!document.querySelector('meta[name="openhomeplan-demo"]');

// In the demo, houses can come from a shared Google Drive folder: ?folder=<link or id> opens it
// (and the browser remembers it), ?folder=none goes back to the sample houses.
function driveFolder() {
  if (!DEMO || !drive.driveKey()) return null;
  const param = new URLSearchParams(location.search).get('folder');
  try {
    if (param === 'none') localStorage.removeItem('openhomeplan:drive-folder');
    else if (param && drive.folderIdFrom(param)) localStorage.setItem('openhomeplan:drive-folder', drive.folderIdFrom(param));
    return param === 'none' ? null : drive.folderIdFrom(param) || localStorage.getItem('openhomeplan:drive-folder');
  } catch {
    return param && param !== 'none' ? drive.folderIdFrom(param) : null;
  }
}
export const DRIVE_FOLDER = driveFolder();
export const folderIdFrom = drive.folderIdFrom;

export const DEMO_NOTICE = 'This is the online demo: nothing can be saved here. Install OpenHomePlan on your computer (free) to keep your houses.';
export const INSTALL_URL = '../#install';

export class DemoError extends Error {}

// Folder that holds a house's files (assets/, BRIEF.md), relative to the page.
export const houseFiles = (slug) => `${DEMO ? 'demo-houses' : 'houses'}/${encodeURIComponent(slug)}/`;
// URL of one house file (e.g. "assets/tiles.jpg"), wherever the house comes from.
export const houseFileUrl = (slug, file) => (DRIVE_FOLDER ? drive.houseFileUrl(slug, file) : `${houseFiles(slug)}${file}`);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function demoRequest(method, url) {
  const path = new URL(url, location.href).pathname.replace(/^.*?\/api\//, '');
  if (method !== 'GET') throw new DemoError(DEMO_NOTICE);
  if (DRIVE_FOLDER) {
    if (path === 'houses') return drive.listHouses(DRIVE_FOLDER);
    const d = path.match(/^houses\/([^/]+)\/(.+)$/);
    if (d) {
      const id = decodeURIComponent(d[1]);
      if (d[2] === 'house') return drive.houseJson(id);
      if (d[2] === 'comments') return drive.comments(id);
      if (d[2] === 'brief') return drive.brief(id);
      if (d[2] === 'history') return [];
    }
  }
  if (path === 'houses') return getJson('demo-houses/index.json');
  if (path === 'config') return { templates: [], housesDir: '' };
  if (path === 'rates') throw new DemoError('Exchange rates are downloaded by the installed app; the online demo shows euros only.');
  const m = path.match(/^houses\/([^/]+)\/(.+)$/);
  if (m) {
    const [, slug, rest] = m;
    if (rest === 'house') return getJson(`${houseFiles(decodeURIComponent(slug))}house.json`);
    if (rest === 'comments' || rest === 'history') return [];
    if (rest === 'brief') {
      const res = await fetch(`${houseFiles(decodeURIComponent(slug))}BRIEF.md`);
      return { text: res.ok ? await res.text() : '' };
    }
  }
  throw new DemoError(DEMO_NOTICE);
}

// JSON request to the server API (`url` like 'api/houses'); in the demo, answered from static files.
export async function request(method, url, body) {
  if (DEMO) return demoRequest(method, url);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
