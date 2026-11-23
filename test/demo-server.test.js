// Functional tests against the Notely demo target (as committed = intentionally
// leaky). They document that the demo really is vulnerable — the whole point of
// the target — and lock in the structural invariants (auth, 404s, owner access).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ALICE_NOTE = '101'; // first seeded note, owner u_alice
let child;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  child = spawn(process.execPath, [path.join(here, '..', 'demo', 'server.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('demo server did not start');
});
after(() => { child?.kill(); });

async function login(user, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `username=${user}&password=${password}`,
  });
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/sid=([^;]+)/);
  return { status: res.status, cookie: m ? `sid=${m[1]}` : null };
}
const get = (p, cookie) => fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

test('health endpoint responds ok', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('login with wrong password sets no session', async () => {
  const { cookie } = await login('alice', 'nope');
  assert.equal(cookie, null);
});

test('login with correct password issues a session cookie', async () => {
  const { cookie } = await login('alice', 'alice123');
  assert.ok(cookie, 'expected a sid cookie');
});

test('owner can read their own note via the API', async () => {
  const { cookie } = await login('alice', 'alice123');
  const r = await get(`/api/notes/${ALICE_NOTE}`, cookie);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /eggs/);
});

test('owner can open their own note page', async () => {
  const { cookie } = await login('alice', 'alice123');
  const r = await get(`/notes/${ALICE_NOTE}`, cookie);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Grocery list/);
});

test('a missing note returns 404 not-found', async () => {
  const { cookie } = await login('alice', 'alice123');
  const r = await get('/notes/99999', cookie);
  assert.equal(r.status, 404);
  assert.match(await r.text(), /Note not found/);
});

test('creating a note requires a login (redirects to /login)', async () => {
  const r = await fetch(`${BASE}/notes`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x&body=y' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location') || '', /\/login/);
});

// --- the intentional vulnerability the demo exists to expose ---------------
test('VULN: a second user can read the owner\'s note via the API', async () => {
  const { cookie } = await login('bob', 'bob123');
  const r = await get(`/api/notes/${ALICE_NOTE}`, cookie);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /eggs/, 'cross-user read leak expected in the leaky demo');
});

test('VULN: a logged-out visitor can read the owner\'s note via the API', async () => {
  const r = await get(`/api/notes/${ALICE_NOTE}`, null);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /eggs/);
});

test('VULN: the forgotten /activity route needs no auth at all', async () => {
  const r = await get(`/api/notes/${ALICE_NOTE}/activity`, null);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /"noteId":"101"/);
});
