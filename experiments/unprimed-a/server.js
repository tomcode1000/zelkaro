import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3001;

// --- Data (in-memory) -------------------------------------------------------

const USERS = {
  alice: 'alice123',
  bob: 'bob123',
};

const sessions = new Map(); // sessionToken -> username
const notes = new Map();    // noteId -> { id, owner, title, body, createdAt }
let nextNoteId = 1;

// --- Helpers ----------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function checkCredentials(username, password) {
  if (!Object.hasOwn(USERS, username)) return false;
  return safeEqual(USERS[username], password);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function currentUser(req) {
  const token = parseCookies(req).session;
  return token ? sessions.get(token) || null : null;
}

async function readForm(req, limit = 100_000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('Body too large');
  }
  return Object.fromEntries(new URLSearchParams(data));
}

// Returns the note only if it exists AND belongs to the given user.
function findOwnedNote(id, username) {
  const note = notes.get(Number(id));
  return note && note.owner === username ? note : null;
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

function page(title, content, user) {
  const nav = user
    ? `<p>Logged in as <strong>${escapeHtml(user)}</strong> · <a href="/">My notes</a> ·
       <form method="post" action="/logout" style="display:inline"><button type="submit">Log out</button></form></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    input, textarea { display: block; width: 100%; margin: .25rem 0 1rem; padding: .5rem; box-sizing: border-box; }
    textarea { min-height: 8rem; }
    .error { color: #b00020; }
    .body { white-space: pre-wrap; }
  </style>
</head>
<body>
  ${nav}
  ${content}
</body>
</html>`;
}

// --- Route handlers ---------------------------------------------------------

function showLogin(res, error = '') {
  sendHtml(res, error ? 401 : 200, page('Log in', `
    <h1>Log in</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/login">
      <label>Username <input name="username" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Log in</button>
    </form>`));
}

async function handleLogin(req, res) {
  const { username = '', password = '' } = await readForm(req);
  if (!checkCredentials(username, password)) return showLogin(res, 'Invalid username or password.');

  const token = randomBytes(32).toString('hex');
  sessions.set(token, username);
  redirect(res, '/', {
    'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/`,
  });
}

function handleLogout(req, res) {
  const token = parseCookies(req).session;
  if (token) sessions.delete(token);
  redirect(res, '/login', {
    'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  });
}

function showIndex(res, user) {
  const mine = [...notes.values()].filter((n) => n.owner === user);
  const list = mine.length
    ? `<ul>${mine.map((n) => `<li><a href="/notes/${n.id}">${escapeHtml(n.title)}</a></li>`).join('')}</ul>`
    : '<p>No notes yet.</p>';

  sendHtml(res, 200, page('My notes', `
    <h1>My notes</h1>
    ${list}
    <h2>New note</h2>
    <form method="post" action="/notes">
      <label>Title <input name="title" maxlength="200" required></label>
      <label>Body <textarea name="body" maxlength="10000"></textarea></label>
      <button type="submit">Create</button>
    </form>`, user));
}

async function createNote(req, res, user) {
  const { title = '', body = '' } = await readForm(req);
  if (!title.trim()) return redirect(res, '/');

  const note = { id: nextNoteId++, owner: user, title: title.trim(), body, createdAt: new Date().toISOString() };
  notes.set(note.id, note);
  redirect(res, `/notes/${note.id}`);
}

function showNote(res, user, id) {
  const note = findOwnedNote(id, user);
  if (!note) return sendHtml(res, 404, page('Not found', '<h1>Note not found</h1>', user));

  sendHtml(res, 200, page(note.title, `
    <h1>${escapeHtml(note.title)}</h1>
    <div class="body">${escapeHtml(note.body)}</div>`, user));
}

function apiNote(res, user, id) {
  const note = findOwnedNote(id, user);
  if (!note) return sendJson(res, 404, { error: 'Not found' });
  const { id: noteId, title, body, createdAt } = note;
  sendJson(res, 200, { id: noteId, title, body, createdAt });
}

// --- Router -----------------------------------------------------------------

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;
  const user = currentUser(req);

  if (pathname === '/login' && method === 'GET') return user ? redirect(res, '/') : showLogin(res);
  if (pathname === '/login' && method === 'POST') return handleLogin(req, res);
  if (pathname === '/logout') return handleLogout(req, res);

  // JSON API: requires a session, answers in JSON (no redirects).
  const apiMatch = pathname.match(/^\/api\/notes\/(\d+)$/);
  if (apiMatch && method === 'GET') {
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
    return apiNote(res, user, apiMatch[1]);
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

  // Everything below requires login.
  if (!user) return redirect(res, '/login');

  if (pathname === '/' && method === 'GET') return showIndex(res, user);
  if (pathname === '/notes' && method === 'POST') return createNote(req, res, user);

  const noteMatch = pathname.match(/^\/notes\/(\d+)$/);
  if (noteMatch && method === 'GET') return showNote(res, user, noteMatch[1]);

  sendHtml(res, 404, page('Not found', '<h1>Not found</h1>', user));
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendHtml(res, 500, page('Error', '<h1>Something went wrong</h1>'));
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Notes app running at http://localhost:${PORT}`);
});
