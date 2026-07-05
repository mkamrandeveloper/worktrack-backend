const { Pool } = require('pg');
const os = require('os');
require('dotenv').config();

// Falls back to a local dev database only outside production, so local
// `npm run dev` keeps working without extra setup. Production must set
// DATABASE_URL (Render/Railway/Supabase all provide this as a connection string).
const DATABASE_URL =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV !== 'production'
    ? `postgres://${os.userInfo().username}@localhost:5432/worktrack_dev`
    : null);

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Provide a PostgreSQL connection string (see .env.example).');
  process.exit(1);
}

// Managed providers (Render, Railway, Supabase) require SSL; local Postgres does not.
const isLocalDb = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const useSsl = process.env.DB_SSL === 'true' || (!isLocalDb && process.env.DB_SSL !== 'false');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });
    pool.on('error', (err) => {
      console.error('Unexpected Postgres pool error:', err.message);
    });
    console.log(`✅ Postgres pool created (ssl: ${useSsl})`);
  }
  return pool;
}

/** Converts SQLite-style `?` positional placeholders into Postgres `$1, $2, ...`. */
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function initSchema() {
  const db = getPool();

  await db.query(`CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    team_size INTEGER DEFAULT 10,
    screenshot_interval INTEGER DEFAULT 1,
    drive_folder_id TEXT,
    drive_folder_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'EMPLOYEE',
    status TEXT NOT NULL DEFAULT 'PENDING',
    drive_folder_id TEXT,
    drive_folder_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS drive_tokens (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT NOT NULL,
    expiry_date BIGINT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    assignee_id TEXT REFERENCES users(id),
    created_by TEXT REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'TODO',
    priority TEXT NOT NULL DEFAULT 'MEDIUM',
    estimated_hours REAL DEFAULT 1,
    logged_hours REAL DEFAULT 0,
    deadline TEXT,
    custom_screenshot_interval INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    started_at TIMESTAMP NOT NULL,
    ended_at TIMESTAMP,
    paused_duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT REFERENCES tasks(id),
    drive_file_id TEXT,
    drive_file_url TEXT,
    captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    upload_status TEXT DEFAULT 'pending',
    error TEXT
  )`);

  // ── Enterprise Extension Tables ──────────────────────────────────────────

  await db.query(`CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    department_id TEXT REFERENCES departments(id),
    name TEXT NOT NULL,
    description TEXT,
    client_name TEXT,
    client_email TEXT,
    company_name TEXT,
    budget REAL DEFAULT 0,
    priority TEXT DEFAULT 'MEDIUM',
    status TEXT DEFAULT 'ACTIVE',
    start_date TEXT,
    deadline TEXT,
    estimated_hours REAL DEFAULT 0,
    actual_hours REAL DEFAULT 0,
    manager_id TEXT REFERENCES users(id),
    client_invite_token TEXT UNIQUE,
    client_invite_accepted INTEGER DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
  )`);

  // Non-destructive, additive columns (safe to re-run on every boot).
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id)`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_name TEXT`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comments TEXT DEFAULT '[]'`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS activity_log TEXT DEFAULT '[]'`);

  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES departments(id)`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
  // Role expansion: 'OWNER' | 'ADMIN' | 'MANAGER' | 'EMPLOYEE' | 'CLIENT'
  // TEXT column already supports any value — no schema change needed.

  await db.query(`CREATE TABLE IF NOT EXISTS time_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    type TEXT NOT NULL CHECK(type IN ('clock_in','clock_out','break_start','break_end','manual')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    task_id TEXT REFERENCES tasks(id),
    project_id TEXT REFERENCES projects(id),
    notes TEXT
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    date TEXT NOT NULL,
    clock_in_time TEXT,
    clock_out_time TEXT,
    total_work_seconds INTEGER DEFAULT 0,
    total_break_seconds INTEGER DEFAULT 0,
    total_idle_seconds INTEGER DEFAULT 0,
    total_overtime_seconds INTEGER DEFAULT 0,
    status TEXT DEFAULT 'absent',
    is_late INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT DEFAULT '{}',
    is_read INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS activity_heartbeats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    status TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id),
    session_id TEXT REFERENCES sessions(id),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    company TEXT,
    invite_token TEXT UNIQUE,
    portal_access INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

// Promisified helpers — same call signature as before (sql with `?` placeholders,
// params array), so route files needed no changes beyond SQLite-only SQL dialect.
async function dbRun(sql, params = []) {
  const result = await getPool().query(toPgPlaceholders(sql), params);
  return { lastID: null, changes: result.rowCount };
}

async function dbGet(sql, params = []) {
  const result = await getPool().query(toPgPlaceholders(sql), params);
  return result.rows[0] || null;
}

async function dbAll(sql, params = []) {
  const result = await getPool().query(toPgPlaceholders(sql), params);
  return result.rows || [];
}

module.exports = { getDb: getPool, initSchema, dbRun, dbGet, dbAll };
