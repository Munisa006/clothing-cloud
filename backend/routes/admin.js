'use strict';

// Admin API. This stands in for the back-office side of the business systems
// (the ERP/CRM/WMS console): staff log in, manage the product catalogue, and
// move orders through their lifecycle. Every route except login is protected
// by the requireAdmin middleware.

const express = require('express');
const { query } = require('../db');
const { login, requireAdmin, requireRole, hashPassword, ROLES } = require('../auth');

const router = express.Router();

// Parse and clamp pagination query params. Defaults to page 1, 20 per page;
// limit is capped so a client cannot ask for an unbounded result set.
function pagination(req, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

// POST /api/admin/login  { username, password } -> { token, user }
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const token = await login(username, password);
    if (!token) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// Everything below requires a valid admin token.
router.use(requireAdmin);

// Who am I — lets the console show the signed-in user and tailor the UI to role.
router.get('/me', (req, res) => {
  res.json({ id: req.user.sub, name: req.user.name, username: req.user.username, role: req.user.role });
});

// --- Dashboard summary ---
router.get('/summary', async (_req, res, next) => {
  try {
    const products = await query('SELECT COUNT(*)::int AS n FROM products');
    const lowStock = await query('SELECT COUNT(*)::int AS n FROM products WHERE stock < 100');
    const orders = await query('SELECT COUNT(*)::int AS n FROM orders');
    const open = await query("SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('received','processing')");
    const revenue = await query("SELECT COALESCE(SUM(total),0)::numeric AS v FROM orders WHERE status <> 'cancelled'");
    res.json({
      products: products.rows[0].n,
      lowStock: lowStock.rows[0].n,
      orders: orders.rows[0].n,
      openOrders: open.rows[0].n,
      revenue: Number(revenue.rows[0].v),
    });
  } catch (err) {
    next(err);
  }
});

// --- Products CRUD ---
router.get('/products', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { rows: countRows } = await query('SELECT COUNT(*)::int AS n FROM products');
    const total = countRows[0].n;
    const { rows } = await query(
      `SELECT id, sku, name, category, unit_price, moq, stock, image_url, created_at
       FROM products ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ items: rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    next(err);
  }
});

router.post('/products', requireRole('manager'), async (req, res, next) => {
  try {
    const { sku, name, category, unit_price, moq, stock, image_url } = req.body || {};
    if (!sku || !name || !category || unit_price == null) {
      return res.status(400).json({ error: 'sku, name, category and unit_price are required' });
    }
    // Use nullish checks so an explicit 0 (e.g. stock 0) is preserved rather
    // than being replaced by the default.
    const { rows } = await query(
      `INSERT INTO products (sku, name, category, unit_price, moq, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [sku, name, category, unit_price, moq ?? 1, stock ?? 0, image_url || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with that SKU already exists' });
    next(err);
  }
});

router.put('/products/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const { name, category, unit_price, moq, stock, image_url } = req.body || {};
    // image_url is set directly (not COALESCE'd) so the admin can clear it by
    // submitting an empty value; an empty string becomes NULL.
    const { rows } = await query(
      `UPDATE products SET
         name = COALESCE($2, name),
         category = COALESCE($3, category),
         unit_price = COALESCE($4, unit_price),
         moq = COALESCE($5, moq),
         stock = COALESCE($6, stock),
         image_url = $7
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, category, unit_price, moq, stock, image_url || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Cannot delete: product is referenced by existing orders' });
    }
    next(err);
  }
});

// --- Orders ---
router.get('/orders', async (req, res, next) => {
  try {
    const { status } = req.query;
    const { page, limit, offset } = pagination(req);
    const filterParams = [];
    let where = '';
    if (status) {
      filterParams.push(status);
      where = 'WHERE o.status = $1';
    }
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS n FROM orders o ${where}`,
      filterParams
    );
    const total = countRows[0].n;
    const pages = Math.max(1, Math.ceil(total / limit));
    const params = filterParams.concat([limit, offset]);
    const { rows: orders } = await query(
      `SELECT o.id, o.reference, o.buyer_name, o.buyer_email, o.status, o.total, o.created_at
       FROM orders o ${where} ORDER BY o.created_at DESC
       LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      params
    );
    if (orders.length === 0) return res.json({ items: [], total, page, limit, pages });

    // Fetch the line items for these orders in one query, then group them in
    // JavaScript. This keeps the SQL simple and portable across Postgres
    // versions instead of depending on JSON aggregate functions.
    const ids = orders.map((o) => o.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: items } = await query(
      `SELECT oi.order_id, oi.product_id, p.name, oi.quantity, oi.unit_price
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id IN (${placeholders})`,
      ids
    );
    const byOrder = {};
    for (const it of items) {
      (byOrder[it.order_id] = byOrder[it.order_id] || []).push({
        product_id: it.product_id, name: it.name, quantity: it.quantity, unit_price: it.unit_price,
      });
    }
    const withItems = orders.map((o) => ({ ...o, items: byOrder[o.id] || [] }));
    res.json({ items: withItems, total, page, limit, pages });
  } catch (err) {
    next(err);
  }
});

const VALID_STATUSES = ['received', 'processing', 'dispatched', 'cancelled'];
router.patch('/orders/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const { rows } = await query(
      'UPDATE orders SET status = $2 WHERE id = $1 RETURNING id, reference, status',
      [req.params.id, status]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- Users (admin only) ---
// Managing staff accounts is the CRM/ERP-style administration surface. Every
// route here requires the admin role; passwords are never returned.

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// Count active admins — used to stop the system locking itself out by removing
// or demoting the last administrator.
async function activeAdminCount() {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = true"
  );
  return rows[0].n;
}

router.get('/users', requireRole('admin'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY created_at, id'
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { username, full_name, password, role } = req.body || {};
    if (!username || !full_name || !password) {
      return res.status(400).json({ error: 'username, full_name and password are required' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3–32 chars: letters, digits, . _ -' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (role && !ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    }
    const { rows } = await query(
      `INSERT INTO users (username, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, full_name, role, is_active, created_at`,
      [username, full_name, hashPassword(String(password)), role || 'staff']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    next(err);
  }
});

router.put('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { full_name, role, is_active, password } = req.body || {};
    if (role && !ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    }
    if (password != null && String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const { rows: existingRows } = await query('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'User not found' });

    // Don't allow removing the last active admin (by demotion or deactivation).
    const losingAdmin = existing.role === 'admin' && existing.is_active
      && ((role && role !== 'admin') || is_active === false);
    if (losingAdmin && (await activeAdminCount()) <= 1) {
      return res.status(409).json({ error: 'Cannot remove the last active administrator' });
    }

    const passwordHash = password != null ? hashPassword(String(password)) : null;
    const { rows } = await query(
      `UPDATE users SET
         full_name = COALESCE($2, full_name),
         role = COALESCE($3, role),
         is_active = COALESCE($4, is_active),
         password_hash = COALESCE($5, password_hash)
       WHERE id = $1
       RETURNING id, username, full_name, role, is_active, created_at`,
      [id, full_name ?? null, role ?? null, is_active ?? null, passwordHash]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.sub) {
      return res.status(409).json({ error: 'You cannot delete your own account' });
    }
    const { rows } = await query('SELECT role, is_active FROM users WHERE id = $1', [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && target.is_active && (await activeAdminCount()) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last active administrator' });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- CRM: Customers ---
router.get('/customers', requireRole('crm_manager'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, company_name, contact_name, contact_email, contact_phone, address, city, country, status, lifetime_value, created_at
       FROM customers ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/customers', requireRole('crm_manager'), async (req, res, next) => {
  try {
    const { company_name, contact_name, contact_email, contact_phone, address, city, country, status } = req.body || {};
    if (!company_name || !contact_name || !contact_email) {
      return res.status(400).json({ error: 'company_name, contact_name and contact_email are required' });
    }
    const { rows } = await query(
      `INSERT INTO customers (company_name, contact_name, contact_email, contact_phone, address, city, country, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [company_name, contact_name, contact_email, contact_phone || null, address || null, city || null, country || null, status || 'active']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- CRM: Interactions ---
router.get('/interactions', requireRole('crm_manager'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.customer_id, c.company_name, c.contact_name, i.interaction_type, i.subject, i.details, i.interaction_date, u.full_name as created_by, i.created_at
       FROM interactions i
       JOIN customers c ON c.id = i.customer_id
       JOIN users u ON u.id = i.created_by
       ORDER BY i.interaction_date DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/interactions', requireRole('crm_manager'), async (req, res, next) => {
  try {
    const { customer_id, interaction_type, subject, details } = req.body || {};
    if (!customer_id || !interaction_type || !subject) {
      return res.status(400).json({ error: 'customer_id, interaction_type and subject are required' });
    }
    const { rows } = await query(
      `INSERT INTO interactions (customer_id, interaction_type, subject, details, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [customer_id, interaction_type, subject, details || null, req.user.sub]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- WMS: Warehouses ---
router.get('/warehouses', requireRole('wms_manager'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, location, capacity, current_stock, is_active, created_at
       FROM warehouses ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/warehouses', requireRole('wms_manager'), async (req, res, next) => {
  try {
    const { name, location, capacity } = req.body || {};
    if (!name || !location) {
      return res.status(400).json({ error: 'name and location are required' });
    }
    const { rows } = await query(
      `INSERT INTO warehouses (name, location, capacity)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, location, capacity || 1000]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- WMS: Inventory ---
router.get('/inventory', requireRole('wms_manager'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ws.id, ws.warehouse_id, w.name as warehouse_name, ws.product_id, p.sku, p.name as product_name, ws.quantity, ws.last_updated
       FROM warehouse_stock ws
       JOIN warehouses w ON w.id = ws.warehouse_id
       JOIN products p ON p.id = ws.product_id
       ORDER BY w.name, p.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// --- WMS: Stock Movements ---
router.get('/stock-movements', requireRole('wms_manager'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT sm.id, sm.warehouse_id, w.name as warehouse_name, sm.product_id, p.sku, p.name as product_name, 
              sm.movement_type, sm.quantity, sm.reference, sm.notes, u.full_name as created_by, sm.created_at
       FROM stock_movements sm
       JOIN warehouses w ON w.id = sm.warehouse_id
       JOIN products p ON p.id = sm.product_id
       JOIN users u ON u.id = sm.created_by
       ORDER BY sm.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/stock-movements', requireRole('wms_manager'), async (req, res, next) => {
  try {
    const { warehouse_id, product_id, movement_type, quantity, reference, notes } = req.body || {};
    if (!warehouse_id || !product_id || !movement_type || !quantity) {
      return res.status(400).json({ error: 'warehouse_id, product_id, movement_type and quantity are required' });
    }
    const { rows } = await query(
      `INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [warehouse_id, product_id, movement_type, quantity, reference || null, notes || null, req.user.sub]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- ERP: Purchase Orders ---
router.get('/purchase-orders', requireRole('erp_manager'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT po.id, po.po_number, po.supplier, po.status, po.total_amount, po.created_at, po.received_at,
              COUNT(poi.id)::int as item_count
       FROM purchase_orders po
       LEFT JOIN po_items poi ON poi.purchase_order_id = po.id
       GROUP BY po.id
       ORDER BY po.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/purchase-orders', requireRole('erp_manager'), async (req, res, next) => {
  try {
    const { po_number, supplier, status, items } = req.body || {};
    if (!po_number || !supplier) {
      return res.status(400).json({ error: 'po_number and supplier are required' });
    }
    const { rows } = await query(
      `INSERT INTO purchase_orders (po_number, supplier, status)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [po_number, supplier, status || 'draft']
    );
    const po = rows[0];
    
    // Insert items if provided
    if (Array.isArray(items) && items.length > 0) {
      let totalAmount = 0;
      for (const item of items) {
        if (item.product_id && item.quantity && item.unit_cost) {
          await query(
            `INSERT INTO po_items (purchase_order_id, product_id, quantity, unit_cost)
             VALUES ($1, $2, $3, $4)`,
            [po.id, item.product_id, item.quantity, item.unit_cost]
          );
          totalAmount += item.quantity * item.unit_cost;
        }
      }
      // Update PO with total
      if (totalAmount > 0) {
        await query('UPDATE purchase_orders SET total_amount = $1 WHERE id = $2', [totalAmount, po.id]);
        po.total_amount = totalAmount;
      }
    }
    res.status(201).json(po);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A purchase order with that number already exists' });
    next(err);
  }
});

module.exports = router;
