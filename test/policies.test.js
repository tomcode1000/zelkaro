// The demo ships deliberately-insecure row policies (the bug Kane catches).
// These tests pin that state, and spec out what a correct fix must satisfy —
// exactly the predicate Claude Code converges on during `heal`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadNote, canWriteNote } from '../demo/policies.js';

const note = { id: '101', owner: 'u_alice', title: 'Payroll', body: 'secret' };
const alice = { id: 'u_alice', name: 'alice' };
const bob = { id: 'u_bob', name: 'bob' };

test('shipped canReadNote is wide open (the planted bug)', () => {
  assert.equal(canReadNote(alice, note), true);
  assert.equal(canReadNote(bob, note), true);   // leak
  assert.equal(canReadNote(null, note), true);  // leak
});

test('shipped canWriteNote lets any signed-in user edit (the planted bug)', () => {
  assert.equal(canWriteNote(alice, note), true);
  assert.equal(canWriteNote(bob, note), true);  // tamper
  assert.equal(canWriteNote(null, note), false);
});

// Specification of a correct fix: owner-only read and write.
const fixedRead = (u, n) => !!u && u.id === n.owner;
const fixedWrite = (u, n) => !!u && u.id === n.owner;

test('SPEC: a correct read policy allows only the owner', () => {
  assert.equal(fixedRead(alice, note), true);
  assert.equal(fixedRead(bob, note), false);
  assert.equal(fixedRead(null, note), false);
});

test('SPEC: a correct write policy allows only the owner', () => {
  assert.equal(fixedWrite(alice, note), true);
  assert.equal(fixedWrite(bob, note), false);
  assert.equal(fixedWrite(null, note), false);
});
