require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DB_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function reset() {
  const hash = await bcrypt.hash('Admin@1234', 10);
  const r = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE email = $2',
    [hash, 'admin@school.ac.ke']
  );
  console.log('Password reset! Rows updated:', r.rowCount);
  await pool.end();
}

reset().catch(err => { console.error(err.message); process.exit(1); });