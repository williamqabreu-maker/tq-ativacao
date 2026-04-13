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
      skip_sigma BOOLEAN DEFAULT FALSE,
      custom_msg TEXT DEFAULT '',
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
  // Migracoes seguras para bancos ja existentes
  await pool.query(`ALTER TABLE plan_maps ADD COLUMN IF NOT EXISTS skip_sigma BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE plan_maps ADD COLUMN IF NOT EXISTS custom_msg TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE activations ADD COLUMN IF NOT EXISTS capi_status TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE activations ADD COLUMN IF NOT EXISTS capi_payload TEXT DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS upload_history (
    id SERIAL PRIMARY KEY,
    filename TEXT,
    total_records INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    started_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP
  )`);
  console.log('DB inicializado');
}

module.exports = { pool, initDB };
