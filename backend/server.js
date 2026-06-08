'use strict';

// Application entry point.
//
// This is the process that runs on each application server in the private
// subnet. Many identical copies of it run behind the load balancer; the
// auto-scaling group adds or removes copies as load changes. Because the app
// keeps no state in memory (all state lives in the database), any copy can
// serve any request, which is what makes horizontal scaling possible.

const path = require('path');
const express = require('express');
const os = require('os');

const { waitForDatabase } = require('./db');
const { init } = require('./init-db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();

app.use(express.json());

// Lightweight request log including which instance served it — handy when
// several containers sit behind the load balancer and you want to see traffic
// being spread across them.
app.use((req, _res, next) => {
  console.log(`[${INSTANCE_ID}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint. The load balancer polls this to decide whether an
// instance is healthy enough to receive traffic. Returning the instance id
// also lets us prove, from a browser, that the load balancer is rotating
// requests across different servers.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', instance: INSTANCE_ID, uptime: process.uptime() });
});

// API routes
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// Static frontends: storefront at /, admin panel at /admin
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/', express.static(path.join(__dirname, 'public')));

// Central error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    await waitForDatabase();
    await init();
    app.listen(PORT, () => {
      console.log(`[server] instance ${INSTANCE_ID} listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  }
}

start();
