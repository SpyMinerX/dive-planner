/*
 * db.js — PostgreSQL access for the Abyss server (and the migration scripts).
 *
 * Connects through DATABASE_URL, or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
 * (on AegisMesh: postgres-ha:5000, which always points at the Patroni primary).
 *
 * Failover: a primary switch drops open connections. pool.on('error') logs the
 * dropped idle clients and the next query simply opens a fresh connection.
 */

import './secrets.js';
import pg from 'pg';

export const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'abyss',
        user: process.env.DB_USER || 'abyss',
        password: process.env.DB_PASSWORD,
      }
);
pool.options.max = parseInt(process.env.DB_POOL_MAX || '10', 10);
pool.options.connectionTimeoutMillis = 5000;
pool.options.idleTimeoutMillis = 30000;

pool.on('error', err => console.warn(`db: idle connection dropped (${err.message})`));

export const query = (text, params) => pool.query(text, params);

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on any throw. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email       text PRIMARY KEY,
  salt        text NOT NULL,
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token    text PRIMARY KEY,
  email    text NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  expires  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires);

-- one document per account: {dives, deleted, settings, settingsUpdatedAt, updatedAt}
CREATE TABLE IF NOT EXISTS logbooks (
  email  text PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  doc    json NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id          text PRIMARY KEY,
  dive        json NOT NULL,
  shared_by   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_created_idx ON shares (created_at);
`;

// arbitrary app-wide key: replicas booting at the same time run the
// CREATE ... IF NOT EXISTS bootstrap one after the other, not concurrently
const SCHEMA_LOCK = 0x4ab755;

/** Creates the schema, retrying with backoff until the database is reachable. */
export async function initDb({ retries = 30 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
        await client.query(SCHEMA);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]).catch(() => {});
        client.release();
      }
      return;
    } catch (e) {
      if (attempt >= retries) throw e;
      const wait = Math.min(1000 * attempt, 5000);
      console.warn(`db: not ready (${e.message}) — retry ${attempt}/${retries} in ${wait} ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
