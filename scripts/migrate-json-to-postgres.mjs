/*
 * migrate-json-to-postgres.mjs — imports the old JSON data (users, sessions,
 * logbooks, shares) into PostgreSQL.
 *
 *   node scripts/migrate-json-to-postgres.mjs --archive /import/abyss-export-….tar [--replace]
 *   node scripts/migrate-json-to-postgres.mjs --data server/data [--replace]
 *
 * --archive  verifies the .sha256 next to the archive, then unpacks it
 * --replace  empties the target tables first (otherwise a non-empty target
 *            is refused)
 *
 * Everything runs in one transaction; row counts are validated against the
 * source before COMMIT, so a failed import leaves the database untouched.
 * Unexpired sessions are carried over, so signed-in devices stay signed in.
 * DB connection: DB_* / DATABASE_URL, same as the server (DB_PASSWORD_FILE works).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool, initDb } from '../server/db.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const REPLACE = args.includes('--replace');
const SHARE_TTL_MS = 90 * 24 * 3600 * 1000;

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const listJson = d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : [];
const logbookName = email => crypto.createHash('sha256').update(email).digest('hex').slice(0, 32) + '.json';

function unpack(archive) {
  const sumFile = archive + '.sha256';
  if (!fs.existsSync(sumFile)) throw new Error(`Missing ${sumFile} — transfer it together with the archive.`);
  const expected = fs.readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (expected !== actual) throw new Error('Archive checksum MISMATCH — re-transfer it (binary mode).');
  console.log('Archive checksum OK');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss-import-'));
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  return dir;
}

async function main() {
  let dataDir = opt('--data');
  let tmp = null;
  if (opt('--archive')) dataDir = tmp = unpack(path.resolve(opt('--archive')));
  if (!dataDir) throw new Error('Give --archive <tar> or --data <dir>.');

  const manifestFile = path.join(dataDir, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : null;
  if (manifest) console.log(`Export from ${manifest.exportedAt}: ${JSON.stringify(manifest.counts)}`);

  /* ---- read the source ---- */
  const users = readJson(path.join(dataDir, 'users.json'));
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const sessions = fs.existsSync(sessionsFile) ? readJson(sessionsFile) : {};
  const now = Date.now();

  const userRows = Object.entries(users).map(([email, u]) => [email, u.salt, u.hash, u.createdAt || new Date().toISOString()]);
  const sessionRows = Object.entries(sessions)
    .filter(([, s]) => users[s.email] && s.expires > now)
    .map(([token, s]) => [token, s.email, new Date(s.expires)]);

  const logbookDir = path.join(dataDir, 'logbooks');
  const byFile = new Map(Object.keys(users).map(e => [logbookName(e), e]));
  const logbookRows = [];
  const orphans = [];
  for (const f of listJson(logbookDir)) {
    const email = byFile.get(f);
    if (!email) { orphans.push(f); continue; }
    logbookRows.push([email, readJson(path.join(logbookDir, f))]);
  }
  const sourceDives = logbookRows.reduce((n, [, d]) => n + (d.dives || []).length, 0);

  const shareDir = path.join(dataDir, 'shares');
  const shareRows = [];
  let expiredShares = 0;
  for (const f of listJson(shareDir)) {
    const s = readJson(path.join(shareDir, f));
    if (now - new Date(s.createdAt).getTime() > SHARE_TTL_MS) { expiredShares++; continue; }
    shareRows.push([f.slice(0, -5), JSON.stringify(s.dive), s.sharedBy, s.createdAt]);
  }

  /* ---- write in one transaction ---- */
  await initDb({ retries: 5 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const existing = (await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    if (existing > 0 && !REPLACE) throw new Error(`Target already has ${existing} users — rerun with --replace to overwrite.`);
    if (REPLACE) await c.query('TRUNCATE shares, logbooks, sessions, users');

    for (const r of userRows) await c.query('INSERT INTO users (email, salt, hash, created_at) VALUES ($1, $2, $3, $4)', r);
    for (const r of sessionRows) await c.query('INSERT INTO sessions (token, email, expires) VALUES ($1, $2, $3)', r);
    for (const [email, doc] of logbookRows) {
      await c.query('INSERT INTO logbooks (email, doc) VALUES ($1, $2)', [email, JSON.stringify(doc)]);
    }
    for (const r of shareRows) await c.query('INSERT INTO shares (id, dive, shared_by, created_at) VALUES ($1, $2, $3, $4)', r);

    /* ---- validate before COMMIT ---- */
    const count = async sql => Number((await c.query(sql)).rows[0].n);
    const checks = [
      ['users', userRows.length, await count('SELECT count(*) AS n FROM users')],
      ['sessions (unexpired)', sessionRows.length, await count('SELECT count(*) AS n FROM sessions')],
      ['logbooks', logbookRows.length, await count('SELECT count(*) AS n FROM logbooks')],
      ['dives', sourceDives, await count("SELECT coalesce(sum(json_array_length(doc->'dives')), 0) AS n FROM logbooks")],
      ['shares (unexpired)', shareRows.length, await count('SELECT count(*) AS n FROM shares')],
    ];
    let ok = true;
    console.log('\n  table                   source   target');
    for (const [name, src, dst] of checks) {
      ok &&= src === dst;
      console.log(`  ${name.padEnd(22)} ${String(src).padStart(7)}  ${String(dst).padStart(7)}  ${src === dst ? 'OK' : 'MISMATCH'}`);
    }
    if (orphans.length) console.log(`  (skipped ${orphans.length} logbook file(s) with no matching user: ${orphans.join(', ')})`);
    if (expiredShares) console.log(`  (skipped ${expiredShares} expired share link(s))`);
    if (!ok) throw new Error('Validation failed — rolled back, nothing was written.');

    await c.query('COMMIT');
    console.log('\nDatabase import committed.');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(`\nImport FAILED: ${e.message}`); process.exit(1); });
