'use strict';

// Unit tests for the auth module that need no database: password hashing,
// token signing/verification via the middleware, and role gating. The
// DB-backed login() flow is covered by the API integration tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-secret';

const { requireAdmin, requireRole, hashPassword, verifyPassword, ROLE_RANK } = require('../auth');

// Minimal Express res double.
function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('hashPassword produces a self-describing scrypt string', () => {
  assert.match(hashPassword('hunter2'), /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
});

test('hashPassword is salted (two hashes of the same password differ)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('verifyPassword accepts the correct password and rejects others', () => {
  const h = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('', h), false);
});

test('verifyPassword rejects malformed stored hashes', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$only-two'), false);
  assert.equal(verifyPassword('x', null), false);
});

// Sign a token the way auth.login would, to exercise the middleware directly.
const crypto = require('crypto');
function makeToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

test('requireAdmin allows a valid token and blocks invalid ones', () => {
  const token = makeToken({ sub: 1, role: 'admin', exp: Date.now() + 1e6 });

  let nexted = false;
  const reqOk = { headers: { authorization: 'Bearer ' + token } };
  requireAdmin(reqOk, mkRes(), () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(reqOk.user.role, 'admin');

  const res401 = mkRes();
  let nexted2 = false;
  requireAdmin({ headers: {} }, res401, () => { nexted2 = true; });
  assert.equal(res401.statusCode, 401);
  assert.equal(nexted2, false);

  const resBad = mkRes();
  requireAdmin({ headers: { authorization: 'Bearer ' + token + 'x' } }, resBad, () => {});
  assert.equal(resBad.statusCode, 401);
});

test('expired tokens are rejected', () => {
  const token = makeToken({ sub: 1, role: 'admin', exp: Date.now() - 1 });
  const res = mkRes();
  requireAdmin({ headers: { authorization: 'Bearer ' + token } }, res, () => {});
  assert.equal(res.statusCode, 401);
});

test('a token with a forged signature is rejected', () => {
  const forged = Buffer.from(JSON.stringify({ sub: 1, role: 'admin', exp: Date.now() + 1e6 })).toString('base64url') + '.deadbeef';
  const res = mkRes();
  requireAdmin({ headers: { authorization: 'Bearer ' + forged } }, res, () => {});
  assert.equal(res.statusCode, 401);
});

test('requireRole enforces the role hierarchy', () => {
  assert.ok(ROLE_RANK.admin > ROLE_RANK.manager);
  assert.ok(ROLE_RANK.manager > ROLE_RANK.staff);

  const gate = requireRole('manager');

  // staff is below manager → 403
  const resStaff = mkRes();
  let staffNext = false;
  gate({ user: { role: 'staff' } }, resStaff, () => { staffNext = true; });
  assert.equal(resStaff.statusCode, 403);
  assert.equal(staffNext, false);

  // manager meets the bar → next()
  let mgrNext = false;
  gate({ user: { role: 'manager' } }, mkRes(), () => { mgrNext = true; });
  assert.equal(mgrNext, true);

  // admin exceeds the bar → next()
  let adminNext = false;
  gate({ user: { role: 'admin' } }, mkRes(), () => { adminNext = true; });
  assert.equal(adminNext, true);
});
