// Google returns here after sign-in with the token in the URL fragment. Hand it to the window
// that asked (same site: BroadcastChannel, or localStorage as a fallback) and close.
const params = new URLSearchParams(location.hash.slice(1));
const msg = { state: params.get('state'), token: params.get('access_token'), expires_in: params.get('expires_in'), error: params.get('error') };
history.replaceState(null, '', location.pathname); // don't leave the token in the address bar
try {
  const ch = new BroadcastChannel('openhomeplan-oauth');
  ch.postMessage(msg);
  ch.close();
} catch {}
try {
  localStorage.setItem('openhomeplan:oauth', JSON.stringify(msg));
  setTimeout(() => localStorage.removeItem('openhomeplan:oauth'), 2000);
} catch {}
document.getElementById('msg').textContent = msg.error ? `Sign-in did not complete (${msg.error}). You can close this window.` : 'Signed in. You can close this window.';
setTimeout(() => window.close(), 600);
