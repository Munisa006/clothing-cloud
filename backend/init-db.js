'use strict';

// Creates the schema if it does not exist and seeds a starter catalogue.
// Running this from the application (rather than only from db/init.sql) means
// the app is self-healing: if it is pointed at a fresh database it will build
// what it needs and carry on.

const { query } = require('./db');
const { hashPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  unit_price  NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  moq         INTEGER NOT NULL DEFAULT 1,   -- minimum order quantity (wholesale)
  stock       INTEGER NOT NULL DEFAULT 0,
  image_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added after the initial release; harmless if the column already exists.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;

CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  buyer_name   TEXT NOT NULL,
  buyer_email  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'received',  -- received | processing | dispatched | cancelled
  total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Back-office staff accounts. Roles gate what each user can do:
--   admin          — full access, including managing other users
--   erp_manager    — ERP (Enterprise Resource Planning) management
--   manager        — manage catalogue and orders, but not users
--   crm_manager    — CRM (Customer Relationship Management) management
--   wms_manager    — WMS (Warehouse Management System) management
--   sales_rep      — sales and CRM support staff
--   warehouse_staff — warehouse and WMS staff
--   staff          — view dashboard/orders and advance order status only
--   viewer         — read-only access
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','manager','staff','erp_manager','crm_manager','wms_manager','sales_rep','warehouse_staff','viewer')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CRM (Customer Relationship Management) Tables
CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  company_name    TEXT NOT NULL,
  contact_name    TEXT NOT NULL,
  contact_email   TEXT NOT NULL,
  contact_phone   TEXT,
  address         TEXT,
  city            TEXT,
  country         TEXT,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','prospect')),
  lifetime_value  NUMERIC(12,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interactions (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('call','email','meeting','note')),
  subject         TEXT NOT NULL,
  details         TEXT,
  interaction_date TIMESTAMPTZ DEFAULT now(),
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interactions_customer ON interactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(interaction_date);

-- WMS (Warehouse Management System) Tables
CREATE TABLE IF NOT EXISTS warehouses (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  location        TEXT NOT NULL,
  capacity        INTEGER DEFAULT 1000,
  current_stock   INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouse_stock (
  id              SERIAL PRIMARY KEY,
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  quantity        INTEGER DEFAULT 0,
  last_updated    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(warehouse_id, product_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id              SERIAL PRIMARY KEY,
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  movement_type   TEXT NOT NULL CHECK (movement_type IN ('inbound','outbound','adjustment')),
  quantity        INTEGER NOT NULL,
  reference       TEXT,
  notes           TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warehouse_stock ON warehouse_stock(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_warehouse ON stock_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);

-- ERP (Enterprise Resource Planning) Tables
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              SERIAL PRIMARY KEY,
  po_number       TEXT NOT NULL UNIQUE,
  supplier        TEXT NOT NULL,
  status          TEXT DEFAULT 'draft' CHECK (status IN ('draft','approved','received','cancelled')),
  total_amount    NUMERIC(12,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  received_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS po_items (
  id              SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  quantity        INTEGER NOT NULL,
  unit_cost       NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id              SERIAL PRIMARY KEY,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  movement_type   TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  reference_type  TEXT,
  reference_id    INTEGER,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_items ON po_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id);
`;

const SEED = [
  ['CLT-TS-001', 'Classic Cotton T-Shirt (12-pack)', 'T-Shirts', 54.00, 5, 800],
  ['CLT-TS-002', 'Heavyweight Crew Tee (12-pack)', 'T-Shirts', 72.00, 5, 540],
  ['CLT-HD-010', 'Fleece Pullover Hoodie (6-pack)', 'Hoodies', 96.00, 4, 360],
  ['CLT-HD-011', 'Zip-Through Hoodie (6-pack)', 'Hoodies', 108.00, 4, 220],
  ['CLT-DN-020', 'Slim-Fit Denim Jeans (10-pack)', 'Denim', 180.00, 3, 300],
  ['CLT-DN-021', 'Relaxed Denim Jeans (10-pack)', 'Denim', 170.00, 3, 280],
  ['CLT-JK-030', 'Lightweight Bomber Jacket (6-pack)', 'Jackets', 210.00, 3, 150],
  ['CLT-JK-031', 'Quilted Winter Jacket (4-pack)', 'Jackets', 264.00, 2, 90],
  ['CLT-AC-040', 'Knit Beanie (24-pack)', 'Accessories', 60.00, 6, 1200],
  ['CLT-AC-041', 'Cotton Crew Socks (50-pack)', 'Accessories', 45.00, 10, 2000],
];

async function init() {
  await query(SCHEMA);
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM products');
  if (rows[0].n === 0) {
    console.log('[init] seeding starter catalogue');
    for (const [sku, name, category, price, moq, stock] of SEED) {
      await query(
        `INSERT INTO products (sku, name, category, unit_price, moq, stock)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sku, name, category, price, moq, stock]
      );
    }
  } else {
    console.log(`[init] catalogue already has ${rows[0].n} products, skipping seed`);
  }

  await seedAdminUser();
  await seedCustomers();
  await seedInteractions();
  await seedWarehouses();
  await seedStockMovements();
  await seedPurchaseOrders();
}

// Ensure there is at least one admin account and seed demo users.
// On a fresh database this creates demo accounts so you can try different roles;
// thereafter accounts are managed through the Users screen.
async function seedAdminUser() {
  // Seed admin and demo users. Don't check for existing users — instead, let the
  // unique constraint handle duplicates and skip them. This allows adding new demo
  // users to an existing database.
  const users = [
    { username: 'admin', fullname: 'Administrator', role: 'admin', password: 'admin123' },
    { username: 'manager', fullname: 'Store Manager', role: 'manager', password: 'manager123' },
    { username: 'staff', fullname: 'Staff Member', role: 'staff', password: 'staff123' },
    { username: 'erp_mgr', fullname: 'ERP Manager', role: 'erp_manager', password: 'erp123' },
    { username: 'crm_mgr', fullname: 'CRM Manager', role: 'crm_manager', password: 'crm123' },
    { username: 'wms_mgr', fullname: 'WMS Manager', role: 'wms_manager', password: 'wms123' },
    { username: 'sales', fullname: 'Sales Rep', role: 'sales_rep', password: 'sales123' },
    { username: 'warehouse', fullname: 'Warehouse Staff', role: 'warehouse_staff', password: 'warehouse123' },
    { username: 'viewer', fullname: 'Read-Only Viewer', role: 'viewer', password: 'viewer123' },
  ];
  
  // Check environment for admin override
  const envUsername = process.env.ADMIN_USER || 'admin';
  const envPasswordHash = process.env.ADMIN_PASSWORD_HASH
    || hashPassword(process.env.ADMIN_PASSWORD || 'admin123');
  
  let seededCount = 0;
  for (const user of users) {
    const username = (user.role === 'admin') ? envUsername : user.username;
    const passwordHash = (user.role === 'admin') ? envPasswordHash : hashPassword(user.password);
    try {
      await query(
        `INSERT INTO users (username, full_name, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [username, user.fullname, passwordHash, user.role]
      );
      console.log(`[init] seeded ${user.role} user "${username}"`);
      seededCount++;
    } catch (err) {
      // Skip if user already exists (unique constraint)
      if (err.code === '23505') {
        console.log(`[init] user "${username}" already exists, skipping`);
      } else {
        throw err;
      }
    }
  }
  if (seededCount > 0) {
    console.log(`[init] total demo users seeded: ${seededCount}`);
  }
}

// Seed CRM demo data: customers
async function seedCustomers() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM customers');
  if (rows[0].n > 0) {
    console.log(`[init] customers table already has data, skipping seed`);
    return;
  }

  const customers = [
    { company: 'Fashion Forward Retail', contact: 'Sarah Chen', email: 'sarah@fashionforward.com', phone: '+1-555-0101', city: 'New York', country: 'USA', status: 'active', lifetime: 50000 },
    { company: 'Urban Style Boutiques', contact: 'Marcus Johnson', email: 'marcus@urbanboutiques.com', phone: '+1-555-0102', city: 'Los Angeles', country: 'USA', status: 'active', lifetime: 38000 },
    { company: 'Vintage Threads Co', contact: 'Emily Rodriguez', email: 'emily@vintagethreads.com', phone: '+1-555-0103', city: 'Austin', country: 'USA', status: 'active', lifetime: 22500 },
    { company: 'Global Fashion Distributors', contact: 'Thomas Weber', email: 'thomas@globalfashion.de', phone: '+49-30-555-0104', city: 'Berlin', country: 'Germany', status: 'active', lifetime: 75000 },
    { company: 'Sustainable Wear Ltd', contact: 'Priya Patel', email: 'priya@sustainablewear.co.uk', phone: '+44-20-555-0105', city: 'London', country: 'UK', status: 'prospect', lifetime: 0 },
  ];

  console.log('[init] seeding customers');
  for (const c of customers) {
    try {
      await query(
        `INSERT INTO customers (company_name, contact_name, contact_email, contact_phone, city, country, status, lifetime_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [c.company, c.contact, c.email, c.phone, c.city, c.country, c.status, c.lifetime]
      );
    } catch (err) {
      console.log(`[init] skipped customer "${c.company}": ${err.message}`);
    }
  }
}

// Seed CRM demo data: interactions
async function seedInteractions() {
  const { rows: customerRows } = await query('SELECT id FROM customers LIMIT 1');
  const { rows: userRows } = await query("SELECT id FROM users WHERE role IN ('crm_manager', 'sales_rep') LIMIT 1");
  
  if (customerRows.length === 0 || userRows.length === 0) {
    console.log('[init] skipping interactions seed (missing customers or users)');
    return;
  }

  const { rows: existingRows } = await query('SELECT COUNT(*)::int AS n FROM interactions');
  if (existingRows[0].n > 0) {
    console.log(`[init] interactions table already has data, skipping seed`);
    return;
  }

  const customerId = customerRows[0].id;
  const userId = userRows[0].id;

  const interactions = [
    { type: 'call', subject: 'Q3 Order Discussion', details: 'Discussed bulk order for fall season' },
    { type: 'email', subject: 'Follow-up on Quotation', details: 'Sent updated pricing for 2024 collection' },
    { type: 'meeting', subject: 'Product Review Meeting', details: 'In-person meeting at customer location' },
    { type: 'note', subject: 'Upsell Opportunity', details: 'Customer interested in new hoodie line' },
  ];

  console.log('[init] seeding interactions');
  for (const i of interactions) {
    try {
      await query(
        `INSERT INTO interactions (customer_id, interaction_type, subject, details, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [customerId, i.type, i.subject, i.details, userId]
      );
    } catch (err) {
      console.log(`[init] skipped interaction: ${err.message}`);
    }
  }
}

// Seed WMS demo data: warehouses and inventory
async function seedWarehouses() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM warehouses');
  if (rows[0].n > 0) {
    console.log(`[init] warehouses table already has data, skipping seed`);
    return;
  }

  const warehouses = [
    { name: 'Main Distribution Hub', location: 'Chicago, IL', capacity: 5000 },
    { name: 'West Coast Warehouse', location: 'Los Angeles, CA', capacity: 3000 },
    { name: 'East Coast Hub', location: 'Newark, NJ', capacity: 4000 },
  ];

  console.log('[init] seeding warehouses');
  for (const w of warehouses) {
    try {
      await query(
        `INSERT INTO warehouses (name, location, capacity, is_active)
         VALUES ($1, $2, $3, true)`,
        [w.name, w.location, w.capacity]
      );
    } catch (err) {
      console.log(`[init] skipped warehouse: ${err.message}`);
    }
  }

  // Now seed warehouse stock
  const { rows: whRows } = await query('SELECT id FROM warehouses');
  const { rows: prodRows } = await query('SELECT id FROM products LIMIT 5');

  if (whRows.length > 0 && prodRows.length > 0) {
    console.log('[init] seeding warehouse stock');
    for (const wh of whRows) {
      for (const prod of prodRows) {
        try {
          const qty = Math.floor(Math.random() * 500) + 50;
          await query(
            `INSERT INTO warehouse_stock (warehouse_id, product_id, quantity)
             VALUES ($1, $2, $3)`,
            [wh.id, prod.id, qty]
          );
        } catch (err) {
          if (err.code !== '23505') console.log(`[init] warehouse stock error: ${err.message}`);
        }
      }
    }
  }
}

// Seed WMS demo data: stock movements
async function seedStockMovements() {
  const { rows: existingRows } = await query('SELECT COUNT(*)::int AS n FROM stock_movements');
  if (existingRows[0].n > 0) {
    console.log(`[init] stock_movements table already has data, skipping seed`);
    return;
  }

  const { rows: whRows } = await query('SELECT id FROM warehouses LIMIT 1');
  const { rows: prodRows } = await query('SELECT id FROM products LIMIT 3');
  const { rows: userRows } = await query("SELECT id FROM users WHERE role IN ('wms_manager', 'warehouse_staff') LIMIT 1");

  if (whRows.length === 0 || prodRows.length === 0 || userRows.length === 0) {
    console.log('[init] skipping stock movements seed (missing data)');
    return;
  }

  const whId = whRows[0].id;
  const userId = userRows[0].id;

  const movements = [];
  for (const prod of prodRows) {
    movements.push({ warehouse_id: whId, product_id: prod.id, type: 'inbound', qty: 100, ref: 'PO-2024-001' });
    movements.push({ warehouse_id: whId, product_id: prod.id, type: 'outbound', qty: 25, ref: 'SO-2024-042' });
  }

  console.log('[init] seeding stock movements');
  for (const m of movements) {
    try {
      await query(
        `INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reference, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [m.warehouse_id, m.product_id, m.type, m.qty, m.ref, userId]
      );
    } catch (err) {
      console.log(`[init] skipped stock movement: ${err.message}`);
    }
  }
}

// Seed ERP demo data: purchase orders
async function seedPurchaseOrders() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM purchase_orders');
  if (rows[0].n > 0) {
    console.log(`[init] purchase_orders table already has data, skipping seed`);
    return;
  }

  const { rows: prodRows } = await query('SELECT id, unit_price FROM products LIMIT 4');

  if (prodRows.length === 0) {
    console.log('[init] skipping purchase orders seed (no products)');
    return;
  }

  const purchaseOrders = [
    { number: 'PO-2024-0001', supplier: 'Cotton Goods International', status: 'approved', items: [{ idx: 0, qty: 500 }, { idx: 1, qty: 300 }] },
    { number: 'PO-2024-0002', supplier: 'Premium Fabric Mills', status: 'received', items: [{ idx: 2, qty: 200 }] },
    { number: 'PO-2024-0003', supplier: 'Global Textiles Ltd', status: 'draft', items: [{ idx: 3, qty: 150 }, { idx: 0, qty: 250 }] },
  ];

  console.log('[init] seeding purchase orders');
  for (const po of purchaseOrders) {
    try {
      // Calculate total
      let total = 0;
      for (const item of po.items) {
        if (prodRows[item.idx]) {
          total += item.qty * parseFloat(prodRows[item.idx].unit_price);
        }
      }

      // Insert PO
      const poResult = await query(
        `INSERT INTO purchase_orders (po_number, supplier, status, total_amount)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [po.number, po.supplier, po.status, total]
      );

      const poId = poResult.rows[0].id;

      // Insert PO items
      for (const item of po.items) {
        if (prodRows[item.idx]) {
          await query(
            `INSERT INTO po_items (purchase_order_id, product_id, quantity, unit_cost)
             VALUES ($1, $2, $3, $4)`,
            [poId, prodRows[item.idx].id, item.qty, prodRows[item.idx].unit_price]
          );
        }
      }

      console.log(`[init]   seeded PO "${po.number}"`);
    } catch (err) {
      console.log(`[init] skipped PO: ${err.message}`);
    }
  }
}

module.exports = { init };
