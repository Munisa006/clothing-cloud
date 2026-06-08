'use strict';

// Admin authentication & authorisation.
//
// Back-office staff log in with a username + password; on success the server
// issues a short-lived HMAC-signed token carrying the user's id, role and name.
// The token is sent on every protected request. Roles gate what each user can
// do (see requireRole).
//
// Accounts live in the `users` table with salted scrypt password hashes
// (memory-hard KDF, built into Node — no native dependency). The default admin
// is seeded from the environment on first boot (see init-db.js):
//
//   ADMIN_USER            default admin username (seed only)
//   ADMIN_PASSWORD_HASH   preferred — an scrypt hash for the seeded admin;
//                         generate one with `npm run hash-password`.
//   ADMIN_PASSWORD        convenience for local/demo — plaintext, hashed at seed.
//
// After first boot, accounts are managed through the Users screen, not the env.

const crypto = require('crypto');
const { query } = require('./db');

const SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // ~16 MB work factor

// Role hierarchy: a role satisfies a requirement if its rank is >= the needed
// rank. Roles with specialized access (crm_manager, wms_manager, erp_manager)
// have appropriate ranks. admin ⊇ erp_manager ⊇ manager ⊇ staff ⊇ viewer
const ROLE_RANK = { 
  viewer: 0,
  staff: 1, 
  warehouse_staff: 1,
  sales_rep: 1,
  crm_manager: 2, 
  wms_manager: 2,
  manager: 2,
  erp_manager: 3,
  admin: 3 
};
const ROLES = Object.keys(ROLE_RANK);

// --- Password hashing (scrypt) ---

// Produce a self-describing hash string: "scrypt$<saltHex>$<hashHex>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// Constant-time verification of a candidate password against a stored hash.
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// --- Token signing / verification ---

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Login ---

// Authenticate against the users table. Always runs a password verification
// (against a dummy hash for unknown/inactive users) so response timing does not
// reveal whether a username exists. Returns a signed token or null.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

async function login(username, password) {
  const { rows } = await query(
    'SELECT id, username, full_name, password_hash, role, is_active FROM users WHERE username = $1',
    [String(username || '')]
  );
  const user = rows[0];
  const hash = user && user.is_active ? user.password_hash : DUMMY_HASH;
  const ok = verifyPassword(String(password || ''), hash);
  if (!user || !user.is_active || !ok) return null;
  return sign({
    sub: user.id,
    name: user.full_name,
    username: user.username,
    role: user.role,
    exp: Date.now() + TOKEN_TTL_MS,
  });
}

// --- Middleware ---

// Require a valid token. Populates req.user = { sub, name, username, role }.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verify(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = payload;
  next();
}

// Require the authenticated user's role to meet or exceed `minRole`.
// Use after requireAdmin.
function requireRole(minRole) {
  const needed = ROLE_RANK[minRole] || 99;
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user && req.user.role] || 0;
    if (rank < needed) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = {
  login, requireAdmin, requireRole,
  hashPassword, verifyPassword,
  ROLES, ROLE_RANK,
};
