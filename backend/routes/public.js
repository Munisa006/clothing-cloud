'use strict';

// Public storefront API: browse the catalogue and place wholesale orders.
// These endpoints are what the customer-facing frontend calls. In the cloud
// design they are reached through the load balancer; the frontend never talks
// to the database directly.

const express = require('express');
const crypto = require('crypto');
const { query, pool } = require('../db');

const router = express.Router();

// GET /api/products  — list catalogue, optional ?category= and ?q= filters
router.get('/products', async (req, res, next) => {
  try {
    const { category, q } = req.query;
    const clauses = [];
    const params = [];
    if (category) {
      params.push(category);
      clauses.push(`category = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      clauses.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT id, sku, name, category, unit_price, moq, stock, image_url
       FROM products ${where} ORDER BY category, name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id
router.get('/products/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, sku, name, category, unit_price, moq, stock, image_url FROM products WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/categories — distinct list for the storefront filter
router.get('/categories', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT DISTINCT category FROM products ORDER BY category');
    res.json(rows.map((r) => r.category));
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:reference — look up a single order by its reference so a
// buyer can track its status after checkout. Public on purpose: the reference
// is the unguessable, randomly generated handle handed to the buyer (it is not
// enumerable like a sequential id), so it acts as a bearer capability for that
// one order. No buyer PII beyond what they already submitted is returned.
router.get('/orders/:reference', async (req, res, next) => {
  try {
    const ref = String(req.params.reference || '').trim().toUpperCase();
    const { rows } = await query(
      `SELECT id, reference, buyer_name, status, total, created_at
       FROM orders WHERE reference = $1`,
      [ref]
    );
    if (!rows.length) return res.status(404).json({ error: 'No order found with that reference' });
    const order = rows[0];
    const { rows: items } = await query(
      `SELECT oi.product_id, p.name, oi.quantity, oi.unit_price
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [order.id]
    );
    delete order.id; // internal id is not part of the public contract
    res.json({ ...order, items });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders — place a wholesale order
// Body: { buyer_name, buyer_email, items: [{ product_id, quantity }] }
// Runs inside a transaction so stock and order rows stay consistent: this is
// exactly the kind of write-heavy path the report flags for further testing.
router.post('/orders', async (req, res, next) => {
  const { buyer_name, buyer_email, items } = req.body || {};
  if (!buyer_name || !buyer_email || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'buyer_name, buyer_email and at least one item are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let total = 0;
    const resolved = [];
    for (const item of items) {
      const qty = parseInt(item.quantity, 10);
      if (!item.product_id || !Number.isInteger(qty) || qty <= 0) {
        throw { status: 400, message: 'Each item needs a product_id and a positive quantity' };
      }
      const { rows } = await client.query(
        'SELECT id, name, unit_price, moq, stock FROM products WHERE id = $1 FOR UPDATE',
        [item.product_id]
      );
      if (!rows.length) throw { status: 400, message: `Unknown product ${item.product_id}` };
      const p = rows[0];
      if (qty < p.moq) throw { status: 400, message: `${p.name} has a minimum order quantity of ${p.moq}` };
      if (qty > p.stock) throw { status: 400, message: `${p.name} only has ${p.stock} in stock` };
      total += Number(p.unit_price) * qty;
      resolved.push({ product_id: p.id, quantity: qty, unit_price: p.unit_price });
    }

    const reference = 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const orderRes = await client.query(
      `INSERT INTO orders (reference, buyer_name, buyer_email, total)
       VALUES ($1, $2, $3, $4) RETURNING id, reference, status, total, created_at`,
      [reference, buyer_name, buyer_email, total.toFixed(2)]
    );
    const order = orderRes.rows[0];

    for (const r of resolved) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [order.id, r.product_id, r.quantity, r.unit_price]
      );
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [r.quantity, r.product_id]);
    }

    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
