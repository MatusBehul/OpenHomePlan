// Comments from the online demo, saved to the commenter's own Google Drive: a plain OAuth sign-in
// (a popup to Google that returns to oauth.html, no Google script on our pages) with the
// `drive.file` permission, which lets the app create and see only its own files. Comments go to
// a folder "OpenHomePlan comments" in the user's My Drive; Google Drive on the computer syncs it
// and the local planner (server.js) moves each one into its house's comments/open/.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const INBOX = 'OpenHomePlan comments';
const TOKEN_KEY = 'openhomeplan:google-token';

export const clientId = () => (typeof document !== 'undefined' && document.querySelector('meta[name="openhomeplan-google-client"]')?.content) || '';
const redirectUri = () => new URL('oauth.html', location.href).href.replace(/[?#].*$/, '');

function cached() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.exp > Date.now() + 60_000 ? t.token : null;
  } catch {
    return null;
  }
}

// An access token: from this tab's session, else via a sign-in popup (call from a click).
export function signIn() {
  const token = cached();
  if (token) return Promise.resolve(token);
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, state, include_granted_scopes: 'true', prompt: 'select_account' });
  const popup = window.open(url, 'openhomeplan-google', 'width=480,height=680');
  if (!popup) return Promise.reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.'));
  return new Promise((resolve, reject) => {
    // oauth.html answers on a BroadcastChannel and, as a fallback, through localStorage
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('openhomeplan-oauth') : null;
    const done = (msg) => {
      if (!msg || msg.state !== state) return;
      cleanup();
      if (msg.error) return reject(new Error(msg.error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${msg.error}`));
      try {
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: msg.token, exp: Date.now() + (Number(msg.expires_in) || 3600) * 1000 }));
      } catch {}
      resolve(msg.token);
    };
    const onStorage = (e) => {
      if (e.key === 'openhomeplan:oauth' && e.newValue) done(JSON.parse(e.newValue));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Google sign-in timed out.'));
    }, 5 * 60_000);
    const cleanup = () => {
      clearTimeout(timer);
      channel?.close();
      window.removeEventListener('storage', onStorage);
    };
    if (channel) channel.onmessage = (e) => done(e.data);
    window.addEventListener('storage', onStorage);
  });
}

async function call(token, url, init = {}) {
  const res = await fetch(url, { ...init, referrerPolicy: 'strict-origin', headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {}
    throw new Error('Your Google sign-in expired. Add the comment again to sign in once more.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Drive: ${data.error?.message || res.statusText}`);
  return data;
}

// The inbox folder in the user's My Drive (created by the app, so drive.file can see it).
async function inbox(token) {
  const q = encodeURIComponent(`name = '${INBOX}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await call(token, `${API}?q=${q}&fields=files(id)&pageSize=1`);
  if (found.files?.length) return found.files[0].id;
  const made = await call(token, `${API}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: INBOX, mimeType: 'application/vnd.google-apps.folder' }) });
  return made.id;
}

const pad = (n) => String(n).padStart(2, '0');
function localIso(d) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const slug = (s) => oneLine(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'house';

// Save a comment on a house from a shared folder. Returns the comment as the app lists them.
export async function saveComment({ houseFolder, houseFolderName, houseName, target, target_name, text, author }) {
  const token = await signIn();
  const folder = await inbox(token);
  const now = new Date();
  const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${slug(target)}`;
  const meta =
    `---\nid: ${id}\ntarget: ${oneLine(target)}\ntarget_name: ${oneLine(target_name || target)}\nstatus: open\ncreated: ${localIso(now)}\n` +
    (author ? `author: ${oneLine(author)}\n` : '') +
    `house_folder: ${oneLine(houseFolderName)}\nhouse_name: ${oneLine(houseName)}\ndrive_folder: ${oneLine(houseFolder)}\nsource: online demo\n---\n\n`;
  const body = `${meta}${String(text).trim()}\n`;
  const boundary = `ohp${Math.random().toString(36).slice(2)}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: `${slug(houseFolderName)}--${id}.md`, parents: [folder], mimeType: 'text/markdown' }) +
    `\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
  await call(token, `${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  return { id, target, target_name: target_name || target, status: 'open', created: localIso(now), folder: 'open', file: `${INBOX}/${id}.md`, body: String(text).trim(), pending: true };
}
