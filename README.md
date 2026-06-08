# MERIDIAN — Wholesale Apparel Cloud Portal

A dynamic Node.js web application built for **Unit 6: Networking in the Cloud**. It is the working implementation of the cloud-deployed website described in the accompanying report: a wholesale clothing distributor's customer-facing storefront plus an operations console that stands in for the back-office ERP / CRM / WMS systems, backed by a PostgreSQL database and packaged for containerised, load-balanced, auto-scaled deployment.

**Author:** Munisa Rakhmonova

---

## What it does

The system has three runtime pieces, each mapping to a layer of the cloud architecture in the report:

**Storefront** (`/`) — Buyers browse the live wholesale catalogue, filter by category, search by name or SKU, and raise a purchase order. Each product has a minimum order quantity (MOQ) and live stock, both enforced at order time. The footer shows which application instance served the page, which makes load balancing visible from the browser.

**Operations console** (`/admin`) — Staff sign in, view a dashboard of catalogue and order figures, manage the product catalogue (create, edit, delete), and move orders through their lifecycle (received → processing → dispatched → cancelled).

**API + database** — An Express REST API on top of PostgreSQL. Orders are written inside a database transaction so stock and order records never drift apart, which is the write-heavy path the report flags for further testing.

---

## Architecture mapping (how the code reflects the report)

| Report concept | In this project |
|----------------|-----------------|
| Application servers in the private application subnet | The `web` (and `web2`) containers running `server.js` — stateless, interchangeable |
| Managed database in a deeper private subnet | The `db` PostgreSQL container; the app reaches it only by its service name |
| Load balancer in the public subnet | The `loadbalancer` nginx container, round-robining across app instances |
| Load-balancer health probe | `GET /health`, also used as the Docker `HEALTHCHECK` |
| Auto-scaling group of identical instances | Multiple interchangeable `web` containers; all state lives in the database |
| CI/CD pipeline (build → test → rolling deploy) | `.github/workflows/ci.yml` |
| Containerisation (Docker / Kubernetes) | `Dockerfile` + `docker-compose.yml` |

---

## Running it

### Prerequisites
- Docker and Docker Compose installed, **or** Node.js 18+ and a local PostgreSQL.

### Option A — single instance (simplest)

```bash
cp .env.example .env        # then edit credentials if you wish
docker compose up --build
```

- Storefront: http://localhost:3000
- Admin console: http://localhost:3000/admin
- Default admin login: `admin` / `admin123` (change these in `.env`)

The catalogue seeds itself with ten sample products the first time the database starts.

### Option B — load-balanced demo (two instances behind nginx)

```bash
docker compose --profile loadbalanced up --build
```

- Entry point (through the load balancer): http://localhost:8080
- Refresh the storefront a few times and watch the "served by instance" line in the footer alternate between `web-1` and `web-2` — that is the load balancer spreading requests, exactly as described in the report.

### Option C — run the backend directly (no Docker)

```bash
# with a PostgreSQL reachable on localhost:5432
cd backend
npm install
DB_HOST=localhost DB_USER=portal DB_PASSWORD=portal_password DB_NAME=portal \
  ADMIN_USER=admin ADMIN_PASSWORD=admin123 npm start
```

---

## Configuration

All configuration is via environment variables (see `.env.example`):

**DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME** — database connection.
**ADMIN_USER** — username of the **default admin account seeded into the `users` table on first boot**. After that, accounts are managed through the console's Users screen, not the environment.
**ADMIN_PASSWORD** *or* **ADMIN_PASSWORD_HASH** — the seeded admin's password. Supply a plaintext `ADMIN_PASSWORD` for local/demo use (hashed before it is stored), or, for production, a pre-computed scrypt hash in `ADMIN_PASSWORD_HASH` and omit the plaintext. Generate a hash with `cd backend && npm run hash-password -- 'your-password'`.
**SESSION_SECRET** — secret used to sign admin session tokens; set a long random value in production.
**PORT** — port the app listens on (default 3000).
**INSTANCE_ID** — label shown in logs and the storefront footer so you can tell instances apart behind the load balancer.

---

## API reference

### Public
- `GET /health` — liveness probe; returns the serving instance id.
- `GET /api/products` — list catalogue. Optional `?category=` and `?q=` filters.
- `GET /api/products/:id` — single product.
- `GET /api/categories` — distinct category list.
- `POST /api/orders` — place an order. Body: `{ buyer_name, buyer_email, items: [{ product_id, quantity }] }`. Validates MOQ and stock inside a transaction. Returns the order reference.
- `GET /api/orders/:reference` — track a placed order by its reference (status, totals, line items). The reference is the unguessable handle handed to the buyer at checkout, so it acts as a capability for that one order; no internal ids are exposed.

### Admin (require `Authorization: Bearer <token>`)
- `POST /api/admin/login` — `{ username, password }` → `{ token }`.
- `GET /api/admin/summary` — dashboard figures.
- `GET /api/admin/products` — catalogue, paginated. Optional `?page=` and `?limit=` (default 20, max 100). Returns `{ items, total, page, limit, pages }`.
- `POST /api/admin/products` — create. `PUT /api/admin/products/:id` — update. `DELETE /api/admin/products/:id` — delete (blocked if referenced by orders).
- `GET /api/admin/orders` — orders with line items, paginated. Optional `?status=`, `?page=`, `?limit=`. Returns `{ items, total, page, limit, pages }`.
- `GET /api/admin/me` — the signed-in user `{ id, name, username, role }`.
- `GET/POST/PUT/DELETE /api/admin/users` — manage back-office accounts. **Admin role only.** Passwords are write-only (never returned). The system refuses to delete or demote the last active administrator.

### Roles

Back-office accounts have one of three roles, enforced server-side and reflected in the console UI:

| Role | Dashboard & orders | Manage catalogue | Manage users |
| --- | :---: | :---: | :---: |
| **Staff** | ✓ (view + advance order status) | — | — |
| **Manager** | ✓ | ✓ | — |
| **Admin** | ✓ | ✓ | ✓ |
- `PATCH /api/admin/orders/:id/status` — update order status.

---

## Project layout

```
clothing-cloud-portal/
├── backend/
│   ├── server.js            # Express entry point, health check, static hosting
│   ├── db.js                # PostgreSQL pool + startup retry
│   ├── init-db.js           # schema creation + catalogue seed
│   ├── auth.js              # admin token auth (HMAC-signed)
│   ├── routes/
│   │   ├── public.js        # storefront API (catalogue, orders)
│   │   └── admin.js         # protected admin API
│   ├── public/              # storefront frontend (HTML/CSS/JS, self-hosted font + icons in vendor/)
│   ├── admin/               # operations console frontend (HTML/CSS/JS, self-hosted assets in vendor/)
│   ├── scripts/
│   │   └── hash-password.js # generate an scrypt ADMIN_PASSWORD_HASH
│   └── test/                # node:test suites (auth unit + API integration)
├── db/init.sql              # schema run by Postgres on first start
├── Dockerfile               # lean Node image with container healthcheck
├── docker-compose.yml       # db + web (+ web2 + nginx under a profile)
├── nginx.conf               # load-balancer config for the demo
├── .github/workflows/ci.yml # CI/CD: build, test against real Postgres, build image
├── .env.example
├── .dockerignore
└── .gitignore
```

---

## Testing notes

Tests use Node's built-in runner (`node:test`, no extra dependencies). Run them with:

```bash
cd backend && npm test
```

There are two layers:

- **Unit tests** (`test/auth.test.js`) — password hashing/verification, token signing, and the auth middleware. These run anywhere, no database needed.
- **API integration tests** (`test/api.test.js`) — boot the real Express app and drive the full HTTP surface (catalogue browse/filter, the order transaction including MOQ and stock rejection paths, order tracking by reference, admin login/authorisation, dashboard aggregation, product CRUD, pagination, and the order lifecycle). They run against a real PostgreSQL; when none is reachable they skip themselves so `npm test` still passes on a bare checkout.

The CI pipeline runs the whole suite against a real `postgres:16` service on every push, then does a live server smoke test. For the performance and scalability testing discussed in the report, point a load-testing tool (for example `k6` or `autocannon`) at the load-balanced entry point on port 8080 and watch the instance label rotate in the footer and logs.

## Security note

Authentication is intentionally self-contained for this coursework demo, but hardened. Back-office accounts live in the `users` table; passwords are stored and compared as salted **scrypt** hashes (never in plaintext) in constant time, and a failed login runs a dummy verification so response timing does not reveal whether a username exists. Session tokens are HMAC-signed and carry the user's role, which is enforced **server-side** on every protected route (role-based access control) — the UI only mirrors what the API already guarantees. The system also refuses to remove the last active administrator. Supply `ADMIN_PASSWORD_HASH` for the seeded admin in production and omit the plaintext password. The frontend escapes all database-supplied content before rendering, and the font and icon assets are self-hosted (no third-party CDN at runtime). A full production deployment would additionally terminate TLS at the load balancer and use a managed identity provider, as the report discusses.
