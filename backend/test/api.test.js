'use strict';

// Integration tests for the full HTTP API against a real PostgreSQL database.
//
// These boot the actual Express app (routes, auth, db, schema/seed) and drive
// it over HTTP. They require a reachable Postgres — exactly what the CI service
// container provides. When no database is reachable (e.g. a plain local
// checkout), the whole suite skips itself instead of failing, so `npm test`
// still passes locally on the unit tests alone.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { pool, waitForDatabase } = require('../db');
const { init } = require('../init-db');
const publicRoutes = require('../routes/public');
const adminRoutes = require('../routes/admin');

let server;
let baseUrl;
let dbAvailable = false;

// Minimal fetch-style helper over the test server.
function request(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(baseUrl + p, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  try {
    await waitForDatabase(1, 0); // single attempt: fail fast if there is no DB
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await init();
  const app = express();
  app.use(express.json());
  app.use('/api', publicRoutes);
  app.use('/api/admin', adminRoutes);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbAvailable) await pool.end();
});

// Register a test that skips at *run time* if no database is reachable. The
// skip decision must be made inside the test body (after before() has run),
// not in the test options, which node:test evaluates eagerly at load time.
function dbTest(name, fn) {
  test(name, async (t) => {
    if (!dbAvailable) { t.skip('no database reachable'); return; }
    await fn(t);
  });
}

// ---------- Public storefront ----------

dbTest('GET /api/products returns the seeded catalogue', async () => {
  const res = await request('GET', '/api/products');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  assert.ok('sku' in res.body[0] && 'unit_price' in res.body[0]);
});

dbTest('GET /api/products?q= filters by name or SKU', async () => {
  const res = await request('GET', '/api/products?q=hoodie');
  assert.equal(res.status, 200);
  assert.ok(res.body.every((p) => /hoodie/i.test(p.name) || /hoodie/i.test(p.sku)));
});

dbTest('GET /api/categories returns a non-empty list', async () => {
  const res = await request('GET', '/api/categories');
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0);
});

dbTest('POST /api/orders enforces MOQ and stock, then succeeds', async () => {
  const products = (await request('GET', '/api/products')).body;
  const p = products.find((x) => x.stock > x.moq);
  assert.ok(p, 'need a product with stock above its MOQ');

  // Below MOQ → rejected.
  const tooFew = await request('POST', '/api/orders', {
    body: { buyer_name: 'Acme', buyer_email: 'buy@acme.test', items: [{ product_id: p.id, quantity: Math.max(1, p.moq - 1) }] },
  });
  assert.equal(tooFew.status, 400);
  assert.match(tooFew.body.error, /minimum order quantity/i);

  // Above stock → rejected.
  const tooMany = await request('POST', '/api/orders', {
    body: { buyer_name: 'Acme', buyer_email: 'buy@acme.test', items: [{ product_id: p.id, quantity: p.stock + 1 }] },
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /in stock/i);

  // Valid → 201 and stock decremented.
  const ok = await request('POST', '/api/orders', {
    body: { buyer_name: 'Acme', buyer_email: 'buy@acme.test', items: [{ product_id: p.id, quantity: p.moq }] },
  });
  assert.equal(ok.status, 201);
  assert.match(ok.body.reference, /^ORD-/);

  const after = (await request('GET', '/api/products/' + p.id)).body;
  assert.equal(after.stock, p.stock - p.moq);
});

dbTest('GET /api/orders/:reference tracks a placed order', async () => {
  const products = (await request('GET', '/api/products')).body;
  const p = products.find((x) => x.stock >= x.moq);
  const placed = await request('POST', '/api/orders', {
    body: { buyer_name: 'Tracker Co', buyer_email: 't@track.test', items: [{ product_id: p.id, quantity: p.moq }] },
  });
  assert.equal(placed.status, 201);

  const lookup = await request('GET', '/api/orders/' + placed.body.reference);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.reference, placed.body.reference);
  assert.equal(lookup.body.status, 'received');
  assert.ok(Array.isArray(lookup.body.items) && lookup.body.items.length === 1);
  assert.equal(lookup.body.id, undefined); // internal id not exposed

  const missing = await request('GET', '/api/orders/ORD-DOESNOTEXIST');
  assert.equal(missing.status, 404);
});

// ---------- Admin ----------

async function adminToken() {
  const res = await request('POST', '/api/admin/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(res.status, 200);
  return res.body.token;
}

async function tokenFor(username, password) {
  const res = await request('POST', '/api/admin/login', { body: { username, password } });
  assert.equal(res.status, 200, `login for ${username} should succeed`);
  return res.body.token;
}

dbTest('admin login rejects bad credentials', async () => {
  const res = await request('POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(res.status, 401);
});

dbTest('admin endpoints require a token', async () => {
  const res = await request('GET', '/api/admin/summary');
  assert.equal(res.status, 401);
});

dbTest('GET /api/admin/me returns the signed-in user with role', async () => {
  const token = await adminToken();
  const res = await request('GET', '/api/admin/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'admin');
  assert.equal(res.body.role, 'admin');
});

dbTest('user management lifecycle and RBAC enforcement', async () => {
  const admin = await adminToken();
  const uname = 'mgr_' + Date.now();

  // Admin creates a manager.
  const created = await request('POST', '/api/admin/users', {
    token: admin, body: { username: uname, full_name: 'Test Manager', password: 'password123', role: 'manager' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'manager');
  assert.equal(created.body.password_hash, undefined); // never leak the hash
  const mgrId = created.body.id;

  // Weak password rejected.
  const weak = await request('POST', '/api/admin/users', {
    token: admin, body: { username: uname + 'x', full_name: 'X', password: 'short' },
  });
  assert.equal(weak.status, 400);

  // Duplicate username → 409.
  const dup = await request('POST', '/api/admin/users', {
    token: admin, body: { username: uname, full_name: 'Dup', password: 'password123' },
  });
  assert.equal(dup.status, 409);

  // The manager can log in…
  const mgr = await tokenFor(uname, 'password123');
  // …and create products (manager role)…
  const prod = await request('POST', '/api/admin/products', {
    token: mgr, body: { sku: 'MGR-' + Date.now(), name: 'Mgr Item', category: 'Test', unit_price: 5 },
  });
  assert.equal(prod.status, 201);
  // …but NOT manage users (admin-only) → 403.
  const forbidden = await request('GET', '/api/admin/users', { token: mgr });
  assert.equal(forbidden.status, 403);

  // Create a staff user and confirm staff cannot mutate products.
  const sname = 'staff_' + Date.now();
  await request('POST', '/api/admin/users', {
    token: admin, body: { username: sname, full_name: 'Test Staff', password: 'password123', role: 'staff' },
  });
  const staff = await tokenFor(sname, 'password123');
  const staffCreate = await request('POST', '/api/admin/products', {
    token: staff, body: { sku: 'NO-' + Date.now(), name: 'Nope', category: 'Test', unit_price: 1 },
  });
  assert.equal(staffCreate.status, 403);

  // Deactivate the manager → login now fails.
  const deactivated = await request('PUT', '/api/admin/users/' + mgrId, {
    token: admin, body: { is_active: false },
  });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.is_active, false);
  const blocked = await request('POST', '/api/admin/login', { body: { username: uname, password: 'password123' } });
  assert.equal(blocked.status, 401);

  // Cannot remove the last active admin.
  const meRes = await request('GET', '/api/admin/me', { token: admin });
  const selfDelete = await request('DELETE', '/api/admin/users/' + meRes.body.id, { token: admin });
  // Either "can't delete self" or "last admin" — both are 409.
  assert.equal(selfDelete.status, 409);

  // Clean up the staff/manager accounts we created.
  await request('DELETE', '/api/admin/users/' + mgrId, { token: admin });
});

dbTest('GET /api/admin/summary returns dashboard figures', async () => {
  const token = await adminToken();
  const res = await request('GET', '/api/admin/summary', { token });
  assert.equal(res.status, 200);
  for (const k of ['products', 'lowStock', 'orders', 'openOrders', 'revenue']) {
    assert.equal(typeof res.body[k], 'number', `summary.${k} is a number`);
  }
});

dbTest('admin products list is paginated', async () => {
  const token = await adminToken();
  const res = await request('GET', '/api/admin/products?page=1&limit=3', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.length <= 3);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 3);
  assert.ok(res.body.total >= res.body.items.length);
  assert.ok(res.body.pages >= 1);
});

dbTest('admin product CRUD lifecycle', async () => {
  const token = await adminToken();
  const sku = 'TEST-' + Date.now();

  // Create
  const created = await request('POST', '/api/admin/products', {
    token, body: { sku, name: 'Test Pack', category: 'Test', unit_price: 9.99, moq: 2, stock: 50 },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // Duplicate SKU → 409
  const dup = await request('POST', '/api/admin/products', {
    token, body: { sku, name: 'Dup', category: 'Test', unit_price: 1 },
  });
  assert.equal(dup.status, 409);

  // Update
  const updated = await request('PUT', '/api/admin/products/' + id, {
    token, body: { name: 'Renamed', category: 'Test', unit_price: 12.5, moq: 2, stock: 40 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Renamed');
  assert.equal(Number(updated.body.unit_price), 12.5);

  // Delete (not referenced by orders) → 204
  const del = await request('DELETE', '/api/admin/products/' + id, { token });
  assert.equal(del.status, 204);

  // Now missing → 404
  const gone = await request('DELETE', '/api/admin/products/' + id, { token });
  assert.equal(gone.status, 404);
});

dbTest('admin orders list paginates and supports status updates', async () => {
  const token = await adminToken();
  const list = await request('GET', '/api/admin/orders?page=1&limit=5', { token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.items));
  assert.equal(list.body.page, 1);

  if (list.body.items.length) {
    const order = list.body.items[0];
    const patched = await request('PATCH', '/api/admin/orders/' + order.id + '/status', {
      token, body: { status: 'processing' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, 'processing');

    const bad = await request('PATCH', '/api/admin/orders/' + order.id + '/status', {
      token, body: { status: 'not-a-status' },
    });
    assert.equal(bad.status, 400);
  }
});
