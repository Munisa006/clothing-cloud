-- Initial schema for the wholesale clothing portal.
--
-- Postgres runs this automatically the first time the database container
-- starts (it is mounted into /docker-entrypoint-initdb.d). The application
-- also creates this schema on startup if it is missing, so the system works
-- whether you point it at this pre-initialised database or an empty one.

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  unit_price  NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  moq         INTEGER NOT NULL DEFAULT 1,
  stock       INTEGER NOT NULL DEFAULT 0,
  image_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  buyer_name   TEXT NOT NULL,
  buyer_email  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'received',
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
