// Small multi-user notes app. Zero dependencies: node:http only.
// Run: node server.js   (PORT env var, default 3002)

import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3002;

// ---------------------------------------------------------------------------
// Data (in memory)
// ---------------------------------------------------------------------------

const USERS = {
  alice: 'alice123',
  bob: 'bob123',
};

const sessions = new Map(); // sessionId -> username
const notes = new Map();    // id -> { id, owner, title, body, createdAt, shareToken }
let nextNoteId = 1;

const newToken = () => randomBytes(24).toString('base64url');

function checkPassword(username, password) {
  const expected = Object.hasOwn(USERS, username) ? USERS[username] : null;
  // Compare hashes so lengths match and timing doesn't leak the password.
  const a = createHash('sha256').update(String(password)).digest();
  const b = createHash('sha256').update(String(expected ?? '')).digest();
  return expected !== null && timingSafeEqual(a, b);
}

function notesFor(username) {
  return [...notes.values()]
    .filter((n) => n.owner === username)
    .sort((a, b) => b.id - a.id);
}

// Owner-only lookup. Returns undefined for missing notes AND other users'
// notes, so callers can't tell the difference (no ID probing).
function ownNote(username, id) {
  const note = notes.get(Number(id));
  return note && note.owner === username ? note : undefined;
}

function sharedNote(token) {
  if (!token) return undefined;
  for (const note of notes.values()) {
    if (note.shareToken && note.shareToken === token) return note;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  return sessions.get(parseCookies(req).sid) || null;
}

function readForm(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', // don't leak share tokens via Referer
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const html = (res, status, body, headers) =>
  send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });

const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

const redirect = (res, location, headers = {}) =>
  send(res, 303, '', { Location: location, ...headers });

// Basic CSRF defence for form POSTs: the request must come from our own origin.
// (The session cookie is also SameSite=Lax.)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // older browsers / curl; SameSite cookie still applies
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function layout(title, user, content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #ddd; margin-bottom: 1rem; }
  input, textarea { width: 100%; box-sizing: border-box; padding: .5rem; margin: .25rem 0 .75rem; font: inherit; }
  textarea { min-height: 8rem; }
  button { padding: .5rem 1rem; font: inherit; cursor: pointer; }
  .body { white-space: pre-wrap; background: #f7f7f7; padding: 1rem; border-radius: 6px; }
  .error { color: #b00020; }
  .muted { color: #666; font-size: .9rem; }
  .inline { display: inline; }
  .link-button { background: none; border: none; color: #06c; text-decoration: underline; padding: 0; }
  code { word-break: break-all; }
</style>
</head>
<body>
<header>
  <h3><a href="/">Notes</a></h3>
  ${user ? `<span>Signed in as <b>${escapeHtml(user)}</b> ·
    <form class="inline" method="post" action="/logout"><button class="link-button">Log out</button></form></span>` : ''}
</header>
${content}
</body>
</html>`;
}

function loginPage(error = '') {
  return layout('Log in', null, `
<h1>Log in</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login">
  <label>Username <input name="username" autocomplete="username" required autofocus></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button>Log in</button>
</form>`);
}

function homePage(user) {
  const list = notesFor(user);
  const items = list.length
    ? `<ul>${list.map((n) => `<li><a href="/notes/${n.id}">${escapeHtml(n.title)}</a></li>`).join('')}</ul>`
    : '<p class="muted">No notes yet.</p>';
  return layout('My notes', user, `
<h1>My notes</h1>
${items}
<h2>New note</h2>
<form method="post" action="/notes">
  <label>Title <input name="title" maxlength="200" required></label>
  <label>Body <textarea name="body" maxlength="20000"></textarea></label>
  <button>Create note</button>
</form>`);
}

function notePage(user, note, req) {
  const shareUrl = note.shareToken ? `http://${req.headers.host}/shared/${note.shareToken}` : null;
  const sharing = shareUrl
    ? `<p>Anyone with this link can read this note:</p>
       <p><code>${escapeHtml(shareUrl)}</code></p>
       <form method="post" action="/notes/${note.id}/unshare"><button>Stop sharing</button></form>`
    : `<p class="muted">This note is private.</p>
       <form method="post" action="/notes/${note.id}/share"><button>Create share link</button></form>`;
  return layout(note.title, user, `
<p><a href="/">&larr; All notes</a></p>
<h1>${escapeHtml(note.title)}</h1>
<div class="body">${escapeHtml(note.body)}</div>
<h2>Share</h2>
${sharing}`);
}

function sharedPage(user, note) {
  return layout(note.title, user, `
<p class="muted">Shared by ${escapeHtml(note.owner)}</p>
<h1>${escapeHtml(note.title)}</h1>
<div class="body">${escapeHtml(note.body)}</div>`);
}

const notFound = (res, user) =>
  html(res, 404, layout('Not found', user, '<h1>Not found</h1><p><a href="/">Back to notes</a></p>'));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;
  const user = currentUser(req);
  let m;

  if (method === 'POST' && !sameOrigin(req)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  // --- Auth ---
  if (pathname === '/login' && method === 'GET') {
    return user ? redirect(res, '/') : html(res, 200, loginPage());
  }

  if (pathname === '/login' && method === 'POST') {
    const { username = '', password = '' } = await readForm(req);
    if (!checkPassword(username, password)) {
      return html(res, 401, loginPage('Invalid username or password.'));
    }
    const sid = newToken();
    sessions.set(sid, username);
    return redirect(res, '/', {
      'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`,
    });
  }

  if (pathname === '/logout' && method === 'POST') {
    sessions.delete(parseCookies(req).sid);
    return redirect(res, '/login', {
      'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  // --- Shared notes: readable by anyone holding the unguessable link ---
  if ((m = pathname.match(/^\/shared\/([\w-]+)$/)) && method === 'GET') {
    const note = sharedNote(m[1]);
    return note ? html(res, 200, sharedPage(user, note)) : notFound(res, user);
  }

  // --- JSON API (owner only) ---
  if ((m = pathname.match(/^\/api\/notes\/(\d+)$/)) && method === 'GET') {
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    const note = ownNote(user, m[1]);
    if (!note) return json(res, 404, { error: 'Not found' });
    const { id, title, body, createdAt } = note;
    return json(res, 200, { id, title, body, createdAt });
  }

  // Everything below requires a logged-in user.
  if (!user) {
    return pathname.startsWith('/api/')
      ? json(res, 401, { error: 'Not authenticated' })
      : redirect(res, '/login');
  }

  if (pathname === '/' && method === 'GET') {
    return html(res, 200, homePage(user));
  }

  if (pathname === '/notes' && method === 'POST') {
    const { title = '', body = '' } = await readForm(req);
    if (!title.trim()) return redirect(res, '/');
    const note = {
      id: nextNoteId++,
      owner: user,
      title: title.trim().slice(0, 200),
      body: body.slice(0, 20000),
      createdAt: new Date().toISOString(),
      shareToken: null,
    };
    notes.set(note.id, note);
    return redirect(res, `/notes/${note.id}`);
  }

  if ((m = pathname.match(/^\/notes\/(\d+)$/)) && method === 'GET') {
    const note = ownNote(user, m[1]);
    return note ? html(res, 200, notePage(user, note, req)) : notFound(res, user);
  }

  if ((m = pathname.match(/^\/notes\/(\d+)\/(share|unshare)$/)) && method === 'POST') {
    const note = ownNote(user, m[1]);
    if (!note) return notFound(res, user);
    note.shareToken = m[2] === 'share' ? newToken() : null;
    return redirect(res, `/notes/${note.id}`);
  }

  return notFound(res, user);
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
    });
  })
  .listen(PORT, () => console.log(`Notes app on http://localhost:${PORT}`));
