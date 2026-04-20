const { Pool } = require('pg');
require('dotenv').config();

const connString = process.env.DB_URL || process.env.DATABASE_URL;

console.log('DB connection string exists:', !!connString);

const pool = new Pool(
  connString
    ? { connectionString: connString, ssl: { rejectUnauthorized: false } }
    : { user: 'postgres', password: 'postgres123', host: '127.0.0.1', port: 5432, database: 'edutrack', ssl: false }
);;

pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected successfully');
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