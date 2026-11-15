// Notely: a tiny multi-user notes app used as Zelkaro's demo target.
// Zero dependencies: run with `node demo/server.js` (Node 18+).
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));

// Policies are re-imported on every request so a fix applied by the coding
// agent takes effect without restarting the server.
async function policies() {
  const url = pathToFileURL(path.join(here, 'policies.js')).href + '?t=' + Date.now();
  return import(url);
}

const USERS = {
  alice: { id: 'u_alice', name: 'alice', password: 'alice123' },
  bob: { id: 'u_bob', name: 'bob', password: 'bob123' },
};
const sessions = new Map(); // sid -> username
const notes = new Map(); // id -> note
let seq = 100;

function seed() {
  const add = (owner, title, body) => {
    const id = String(++seq);
    notes.set(id, { id, owner, title, body });
  };
  add('u_alice', 'Grocery list', 'eggs, oat milk, coffee');
  add('u_bob', 'Gym plan', 'push / pull / legs');
}
seed();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, user, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Notely</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
a{color:#0b57d0} input,textarea{width:100%;padding:8px;margin:4px 0 12px;font:inherit;box-sizing:border-box}
button{padding:8px 16px;font:inherit;cursor:pointer} .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:12px}
.err{color:#b00020} .who{font-size:14px;color:#555}
</style></head><body>
<header><strong><a href="/">Notely</a></strong><span class="who">${user ? `Signed in as <b id="whoami">${esc(user.name)}</b> · <a href="/logout">Log out</a>` : '<a href="/login">Log in</a>'}</span></header>
${body}</body></html>`;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  const name = sid && sessions.get(sid);
  return name ? USERS[name] : null;
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return Object.fromEntries(new URLSearchParams(data));
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}
const redirect = (res, to, headers = {}) => { res.writeHead(303, { location: to, ...headers }); res.end(); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const user = currentUser(req);
    const p = url.pathname;

    if (p === '/health') return send(res, 200, 'ok');

    if (p === '/login' && req.method === 'GET') {
      return send(res, 200, page('Log in', null, `<h1>Log in</h1>
<form method="post" action="/login" class="card">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Log in</button></form>
${url.searchParams.get('e') ? '<p class="err">Wrong username or password.</p>' : ''}`));
    }
    if (p === '/login' && req.method === 'POST') {
      const { username = '', password = '' } = await readBody(req);
      const u = USERS[username.trim().toLowerCase()];
      if (!u || u.password !== password) return redirect(res, '/login?e=1');
      const sid = crypto.randomBytes(16).toString('hex');
      sessions.set(sid, u.name);
      return redirect(res, '/', { 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (p === '/logout') {
      const sid = parseCookies(req).sid;
      if (sid) sessions.delete(sid);
      return redirect(res, '/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }

    if (p === '/' ) {
      if (!user) return redirect(res, '/login');
      const mine = [...notes.values()].filter((n) => n.owner === user.id);
      return send(res, 200, page('My notes', user, `<h1>My notes</h1>
${mine.map((n) => `<div class="card"><a href="/notes/${n.id}">${esc(n.title)}</a> <span class="who">#${n.id}</span></div>`).join('') || '<p>No notes yet.</p>'}
<h2>New note</h2>
<form method="post" action="/notes" class="card">
<label>Title <input name="title"></label>
<label>Body <textarea name="body" rows="3"></textarea></label>
<button type="submit">Save note</button></form>`));
    }

    if (p === '/notes' && req.method === 'POST') {
      if (!user) return redirect(res, '/login');
      const { title = 'Untitled', body = '' } = await readBody(req);
      const id = String(++seq);
      notes.set(id, { id, owner: user.id, title, body });
      return redirect(res, `/notes/${id}`);
    }

    const m = p.match(/^\/(api\/)?notes\/(\d+)$/);
    if (m) {
      const note = notes.get(m[2]);
      const { canReadNote } = await policies();
      const allowed = note && canReadNote(user, note);
      if (m[1]) {
        res.writeHead(allowed ? 200 : 404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(allowed ? note : { error: 'not found' }));
      }
      if (!allowed) return send(res, 404, page('Not found', user, '<h1>Note not found</h1><p id="denied">This note does not exist or you do not have access.</p>'));
      return send(res, 200, page(note.title, user, `<article class="card"><h1 id="note-title">${esc(note.title)}</h1>
<p id="note-body">${esc(note.body)}</p><p class="who">Note #${note.id}</p></article><p><a href="/">Back to my notes</a></p>`));
    }

    send(res, 404, page('Not found', user, '<h1>Not found</h1>'));
  } catch (err) {
    console.error(err);
    send(res, 500, 'Internal error');
  }
});

server.listen(PORT, () => console.log(`Notely listening on http://localhost:${PORT}`));
