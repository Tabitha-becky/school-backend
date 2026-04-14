// ─────────────────────────────────────────────────────────────
//  scripts/setupDb.js
//  Run once after applying schema.sql to create the default admin
//  Usage: node scripts/setupDb.js
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const setup = async () => {
  const client = await pool.connect();
  try {
    console.log('🏫  EduTrack Kenya — Database Setup\n');

    // Check if admin exists
    const existing = await client.query(
      "SELECT id FROM users WHERE email = 'admin@school.ac.ke'"
    );

    if (existing.rows.length > 0) {
      console.log('ℹ️   Admin account already exists. Skipping creation.');
    } else {
      const hashedPassword = await bcrypt.hash('Admin@1234', 12);
      await client.query(
        `INSERT INTO users (name, email, password, role, phone)
         VALUES ($1, $2, $3, $4, $5)`,
        ['System Administrator', 'admin@school.ac.ke', hashedPassword, 'admin', '+254700000000']
      );
      console.log('✅  Default admin account created:');
      console.log('    Email:    admin@school.ac.ke');
      console.log('    Password: Admin@1234');
      console.log('\n⚠️   IMPORTANT: Change this password immediately after first login!\n');
    }

    // Verify tables exist
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );
    console.log('📋  Tables found in database:');
    tables.rows.forEach(t => console.log(`    ✓ ${t.table_name}`));

    const subjects = await client.query('SELECT COUNT(*) FROM subjects');
    const classes = await client.query('SELECT COUNT(*) FROM classes');
    console.log(`\n📚  Subjects: ${subjects.rows[0].count}`);
    console.log(`🏫  Classes:  ${classes.rows[0].count}`);
    console.log('\n🚀  Setup complete! Run: npm run dev\n');
  } catch (err) {
    console.error('❌  Setup failed:', err.message);
    console.error('    Make sure PostgreSQL is running and DB_URL in .env is correct.');
    console.error('    Also make sure you ran schema.sql first.\n');
  } finally {
    client.release();
    pool.end();
  }
};

setup();