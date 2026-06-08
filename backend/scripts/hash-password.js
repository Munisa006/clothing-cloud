'use strict';

// Generate an scrypt password hash for the admin console.
//
//   node scripts/hash-password.js 'my-strong-password'
//   npm run hash-password -- 'my-strong-password'
//
// Copy the printed line into your environment (or .env) as ADMIN_PASSWORD_HASH
// and remove the plaintext ADMIN_PASSWORD. The hash is safe to commit to a
// secrets manager; it cannot be reversed to the original password.

const { hashPassword } = require('../auth');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

console.log('ADMIN_PASSWORD_HASH=' + hashPassword(password));
