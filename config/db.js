// ─────────────────────────────────────────────────────────────
//  db.js — PostgreSQL Connection Pool
//  Uses the 'pg' library with connection pooling for performance
// ─────────────────────────────────────────────────────────────
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: 'postgres',
  password: 'postgres123',
  host: '127.0.0.1',
  port: 5432,
  database: 'edutrack',
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('Database connected successfully');
    release();
  }
});

const query = async (text, params) => {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    console.error('Query Error:', err.message);
    throw err;
  }
};

module.exports = { pool, query };