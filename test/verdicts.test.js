// Unit tests for the verdict logic in src/scan.js — the rules that decide
// leak vs blocked vs inconclusive. A bug here would let a real leak be reported
// as "sealed", so these are the most important tests in the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandUrl, findUrl, loginPhrase, failedAssert, readVerdict, ownerVerdict } from '../src/scan.js';

const CANARY = 'CANARY-abc123';
const TAMPER = 'TAMPERED-def456';
const assertStep = (txt) => [{ status: 'failed', summary: `assert: ${txt}` }];
const cfg = {
  baseUrl: 'http://localhost:3000', loginPath: '/login',
  users: { owner: { username: 'alice', password: 'a' }, intruder: { username: 'bob', password: 'b' } },
};

// ---- expandUrl -------------------------------------------------------------
test('expandUrl fills {origin} and {id} from the planted URL', () => {
  assert.equal(expandUrl('{origin}/notes/{id}/edit', 'http://h:3000/notes/103'), 'http://h:3000/notes/103/edit');
});
test('expandUrl fills {url} with the whole planted URL', () => {
  assert.equal(expandUrl('{url}', 'http://h/notes/9'), 'http://h/notes/9');
});
test('expandUrl {id} is the last path segment', () => {
  assert.equal(expandUrl('{id}', 'http://h/a/b/c/777'), '777');
});

// ---- findUrl ---------------------------------------------------------------
test('findUrl prefers an extracted variable over the browser final url', () => {
  const end = { final_state: { url: 'http://h/x' }, context: { variables: { planted_url: { value: 'http://h/notes/5' } } } };
  assert.equal(findUrl(end, 'http://h'), 'http://h/notes/5');
});
test('findUrl falls back to url when nothing else matches the origin', () => {
  assert.equal(findUrl({ final_state: { url: 'http://h/only' } }, 'http://h'), 'http://h/only');
});
test('findUrl returns null when no value is on the origin', () => {
  assert.equal(findUrl({ final_state: { url: 'http://other/x' } }, 'http://h'), null);
});
test('findUrl returns null for an empty end', () => {
  assert.equal(findUrl({}, 'http://h'), null);
});

// ---- loginPhrase -----------------------------------------------------------
test('loginPhrase for anonymous says not to log in', () => {
  assert.equal(loginPhrase(cfg, 'anonymous'), 'Do not log in.');
});
test('loginPhrase uses the secret password variable, never the literal', () => {
  const p = loginPhrase(cfg, 'owner');
  assert.match(p, /\{\{user_1_password\}\}/);
  assert.doesNotMatch(p, /\balice's password\b/);
});
test('loginPhrase orders submit before the signed-in check (Step 1/2/3)', () => {
  const p = loginPhrase(cfg, 'intruder');
  assert.ok(p.indexOf('Step 1') < p.indexOf('Step 2'));
  assert.match(p, /\{\{user_2_password\}\}/);
  assert.match(p, /signed in as bob/);
});
test('loginPhrase honours a custom signedInCheck', () => {
  const c2 = { ...cfg, users: { ...cfg.users, owner: { username: 'alice', password: 'a', signedInCheck: 'the dashboard header says Alice' } } };
  assert.match(loginPhrase(c2, 'owner'), /the dashboard header says Alice/);
});

// ---- failedAssert ----------------------------------------------------------
test('failedAssert returns the failed assertion summary', () => {
  assert.match(failedAssert(assertStep(`'${CANARY}' is NOT visible`), {}), /CANARY-abc123/);
});
test('failedAssert falls back to end.reason when no assertion failed', () => {
  assert.equal(failedAssert([], { reason: 'timeout' }), 'timeout');
});

// ---- readVerdict (probe) ---------------------------------------------------
test('readVerdict: a passing run is blocked', () => {
  assert.equal(readVerdict({ end: { status: 'passed', one_liner: 'ok' } }, CANARY, []).verdict, 'blocked');
});
test('readVerdict: assertion failed AND the canary is in it = leak', () => {
  const res = { end: { status: 'failed', reason_code: 'assertion_error.final_verification' } };
  assert.equal(readVerdict(res, CANARY, assertStep(`'${CANARY}' is NOT visible`)).verdict, 'leak');
});
test('readVerdict: a failed SIGN-IN assertion is inconclusive, never a leak', () => {
  const res = { end: { status: 'failed', reason_code: 'assertion_error.final_verification' } };
  assert.equal(readVerdict(res, CANARY, assertStep('the page shows you are signed in as bob')).verdict, 'inconclusive');
});
test('readVerdict: a non-assertion failure is inconclusive', () => {
  const res = { end: { status: 'failed', reason_code: 'infra_error.screenshot_failed', reason: 'crash' } };
  assert.equal(readVerdict(res, CANARY, []).verdict, 'inconclusive');
});
test('readVerdict: no result is an error', () => {
  assert.equal(readVerdict({ end: null, stderr: 'boom' }, CANARY, []).verdict, 'error');
});

// ---- ownerVerdict (control + tamper judgment) ------------------------------
test('ownerVerdict: owner passes = ok, and a configured tamper is blocked', () => {
  const v = ownerVerdict({ end: { status: 'passed', one_liner: 'ok' } }, CANARY, TAMPER, []);
  assert.equal(v.owner.verdict, 'ok');
  assert.equal(v.tamper, 'blocked');
});
test('ownerVerdict: owner page shows the tamper token = tampered', () => {
  const res = { end: { status: 'failed', reason_code: 'assertion_error.final_verification' } };
  const v = ownerVerdict(res, CANARY, TAMPER, assertStep(`'${TAMPER}' is NOT visible`));
  assert.equal(v.tamper, 'tampered');
  assert.equal(v.owner.verdict, 'ok');
});
test('ownerVerdict: owner can no longer see their own canary = owner-locked-out', () => {
  const res = { end: { status: 'failed', reason_code: 'assertion_error.final_verification' } };
  const v = ownerVerdict(res, CANARY, TAMPER, assertStep(`'${CANARY}' IS visible`));
  assert.equal(v.owner.verdict, 'owner-locked-out');
});
test('ownerVerdict: no result = error, tamper inconclusive', () => {
  const v = ownerVerdict({ end: null, stderr: 'x' }, CANARY, TAMPER, []);
  assert.equal(v.owner.verdict, 'error');
  assert.equal(v.tamper, 'inconclusive');
});
test('ownerVerdict: with no tamper configured, tamper stays null', () => {
  const v = ownerVerdict({ end: { status: 'passed' } }, CANARY, null, []);
  assert.equal(v.tamper, null);
});
