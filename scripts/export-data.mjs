/*
 * export-data.mjs — packs the pre-PostgreSQL JSON data directory (users,
 * sessions, logbooks, shares) into one .tar plus a sha256sum-compatible
 * .sha256, for transfer to AegisMesh and import with
 * migrate-json-to-postgres.mjs. Run it with the old server stopped so the
 * snapshot is consistent.
 *
 *   node scripts/export-data.mjs --data /app/server/data --out /export
 *
 * The archive holds every account's password hash and logbook: delete it
 * once the import is verified.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DATA = path.resolve(opt('--data') || 'server/data');
const OUT = path.resolve(opt('--out') || '.');

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const listJson = d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : [];

if (!fs.existsSync(path.join(DATA, 'users.json'))) {
  console.error(`No users.json in ${DATA} — is --data pointing at the old data volume?`);
  process.exit(1);
}

const users = readJson(path.join(DATA, 'users.json'));
const sessionsFile = path.join(DATA, 'sessions.json');
const sessions = fs.existsSync(sessionsFile) ? readJson(sessionsFile) : {};
let dives = 0;
for (const f of listJson(path.join(DATA, 'logbooks'))) {
  dives += (readJson(path.join(DATA, 'logbooks', f)).dives || []).length;
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const manifest = {
  app: 'abyss',
  format: 'abyss-json-v1',
  exportedAt: new Date().toISOString(),
  counts: {
    users: Object.keys(users).length,
    sessions: Object.keys(sessions).length,
    logbookFiles: listJson(path.join(DATA, 'logbooks')).length,
    dives,
    shares: listJson(path.join(DATA, 'shares')).length,
  },
};

// stage the manifest and a copy of the data (BusyBox tar honours only one -C)
const stage = fs.mkdtempSync(path.join(OUT, '.abyss-export-'));
const name = `abyss-export-${stamp}.tar`;
const tar = path.join(OUT, name);
try {
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const parts = ['users.json', 'sessions.json', 'logbooks', 'shares'].filter(p => fs.existsSync(path.join(DATA, p)));
  for (const p of parts) fs.cpSync(path.join(DATA, p), path.join(stage, p), { recursive: true });
  execFileSync('tar', ['-cf', tar, '-C', stage, 'manifest.json', ...parts]);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
  fs.writeFileSync(tar + '.sha256', `${sum}  ${name}\n`);
  console.log(JSON.stringify(manifest.counts));
  console.log(`Wrote ${tar} (${(fs.statSync(tar).size / 1e6).toFixed(1)} MB) and ${name}.sha256`);
} catch (e) {
  fs.rmSync(tar, { force: true });
  throw e;
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
