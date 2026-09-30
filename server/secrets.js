/*
 * secrets.js — Swarm secret support. For every `<NAME>_FILE` environment
 * variable, reads that file and exposes its (trimmed) content as `<NAME>`,
 * unless `<NAME>` is already set. Import this before anything reads config.
 *
 *   DB_PASSWORD_FILE=/run/secrets/abyss_db_password  →  DB_PASSWORD=<content>
 */

import fs from 'node:fs';

for (const [key, file] of Object.entries(process.env)) {
  if (!key.endsWith('_FILE') || !file) continue;
  const name = key.slice(0, -'_FILE'.length);
  if (process.env[name]) continue;
  try {
    process.env[name] = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (e) {
    console.error(`Cannot read secret ${key}=${file}: ${e.message}`);
    process.exit(1);
  }
}
