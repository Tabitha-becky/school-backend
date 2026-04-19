require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Connected to Railway database...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    
    // Split by semicolon and run each statement separately
    const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await client.query(stmt);
        console.log(`✓ Statement ${i + 1}/${statements.length} done`);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log(`⚠ Statement ${i + 1} skipped (already exists)`);
        } else {
          console.log(`✗ Statement ${i + 1} error: ${err.message}`);
        }
      }
    }

    // Create default admin
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const hash = await bcrypt.hash('Admin@1234', 10);
    
    try {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (email) DO NOTHING`,
        [uuidv4(), 'System Administrator', 'admin@school.ac.ke', hash, 'admin']
      );
      console.log('✓ Default admin created: admin@school.ac.ke / Admin@1234');
    } catch (err) {
      console.log('⚠ Admin already exists');
    }

    console.log('\n🎉 Database setup complete!');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});