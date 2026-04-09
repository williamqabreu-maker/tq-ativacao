const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_maps (
      id SERIAL PRIMARY KEY,
      braip_name TEXT NOT NULL,
      sigma_package_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      trans_key TEXT UNIQUE,
      client_name TEXT,
      client_email TEXT,
      client_cel TEXT,
      plan_name TEXT,
      sigma_username TEXT,
      sigma_password TEXT,
      status TEXT DEFAULT 'success',
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('DB inicializado');
}

module.exports = { pool, initDB };
