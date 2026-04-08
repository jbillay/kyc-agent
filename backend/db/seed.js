'use strict';

const bcrypt = require('bcrypt');
const { query } = require('./connection');

async function seed() {
  const { rows } = await query(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  );

  if (rows.length > 0) {
    console.log('Seed skipped: admin account already exists');
    return;
  }

  const passwordHash = await bcrypt.hash('admin', 10);

  await query(
    `INSERT INTO users (email, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    ['admin@kycagent.local', 'System Admin', 'admin', passwordHash, true]
  );

  console.log('Admin user created: admin@kycagent.local');
  console.log('⚠ WARNING: Change the default admin password immediately.');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
