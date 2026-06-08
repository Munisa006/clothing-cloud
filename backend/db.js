'use strict';

// Database access layer.
//
// In the cloud architecture described in the report, this module is what the
// application servers (private application subnet) use to reach the managed
// database service that lives in a separate, deeper private subnet. The pool
// keeps a small set of reusable connections so we are not opening a new TCP
// connection to the database on every request.

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'portal',
  password: process.env.DB_PASSWORD || 'portal_password',
  database: process.env.DB_NAME || 'portal',
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error:', err.message);
});

// Wait for the database to accept connections. When the whole stack starts at
// once (docker compose up), the database container may not be ready before the
// application container. Rather than crash, we retry with a short backoff,
// which mirrors how a real deployment tolerates a database that is still
// coming online behind the network.
async function waitForDatabase(maxAttempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log('[db] connection established');
      return;
    } catch (err) {
      console.log(`[db] not ready (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database did not become available in time');
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, waitForDatabase };
