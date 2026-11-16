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
    notes.set(id, { id, owner, title, body, activity: [] });
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
      notes.set(id, { id, owner: user.id, title, body, activity: [{ at: new Date().toISOString(), by: user.name, action: 'created', snapshot: body }] });
      return redirect(res, `/notes/${id}`);
    }

    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const notFound = () => send(res, 404, page('Not found', user, '<h1>Note not found</h1><p id="denied">This note does not exist or you do not have access.</p>'));

    // JSON API used by the note page (and a future mobile app).
    let m = p.match(/^\/api\/notes\/(\d+)$/);
    if (m) {
      const note = notes.get(m[1]);
      const { canReadNote } = await policies();
      if (!note || !canReadNote(user, note)) return json(404, { error: 'not found' });
      const { activity, ...pub } = note;
      return json(200, pub);
    }

    // Activity feed added later for the "last edited" panel. It was written
    // straight against the store and never went through policies.js: the kind
    // of forgotten route nobody lists in a test plan.
    m = p.match(/^\/api\/notes\/(\d+)\/activity$/);
    if (m) {
      const note = notes.get(m[1]);
      if (!note) return json(404, { error: 'not found' });
      return json(200, { noteId: note.id, events: note.activity });
    }

    // Edit page.
    m = p.match(/^\/notes\/(\d+)\/edit$/);
    if (m) {
      const note = notes.get(m[1]);
      const { canWriteNote } = await policies();
      if (!note || !canWriteNote(user, note)) return notFound();
      if (req.method === 'POST') {
        const { body = '' } = await readBody(req);
        note.body = body;
        note.activity.push({ at: new Date().toISOString(), by: user?.name || 'anonymous', action: 'edited', snapshot: body });
        return redirect(res, `/notes/${note.id}`);
      }
      return send(res, 200, page('Edit note', user, `<h1>Edit note</h1>
<form method="post" action="/notes/${note.id}/edit" class="card">
<label>Body <textarea name="body" rows="4">${esc(note.body)}</textarea></label>
<button type="submit">Save changes</button></form>`));
    }

    // Note page: a shell that loads its content from the API, like most
    // modern front ends.
    m = p.match(/^\/notes\/(\d+)$/);
    if (m) {
      const note = notes.get(m[1]);
      const { canReadNote } = await policies();
      if (!note || !canReadNote(user, note)) return notFound();
      return send(res, 200, page(note.title, user, `<article class="card"><h1 id="note-title">${esc(note.title)}</h1>
<p id="note-body">Loading…</p><p class="who">Note #${note.id} · <a href="/notes/${note.id}/edit">Edit</a></p></article>
<div class="card"><b>Activity</b><ul id="activity"></ul></div>
<p><a href="/">Back to my notes</a></p>
<script>
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
fetch('/api/notes/${note.id}').then((r) => r.json()).then((n) => { document.getElementById('note-body').textContent = n.body ?? ''; });
fetch('/api/notes/${note.id}/activity').then((r) => r.json()).then((a) => {
  document.getElementById('activity').innerHTML = (a.events || []).map((e) => '<li>' + esc(e.action) + ' by ' + esc(e.by) + '</li>').join('');
});
</script>`));
    }

    send(res, 404, page('Not found', user, '<h1>Not found</h1>'));
  } catch (err) {
    console.error(err);
    send(res, 500, 'Internal error');
  }
});

server.listen(PORT, () => console.log(`Notely listening on http://localhost:${PORT}`));
