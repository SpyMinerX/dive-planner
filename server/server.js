/*
 * server.js — Abyss cloud server. Zero dependencies (Node 18+).
 *
 * Serves the PWA and a small JSON API:
 *   POST /api/register   {email, password}            → {token, email}
 *   POST /api/login      {email, password}            → {token, email}
 *   POST /api/logout     (Bearer)                     → {ok}
 *   GET  /api/me         (Bearer)                     → {email}
 *   GET  /api/logbook    (Bearer)                     → {dives, deleted, updatedAt}
 *   PUT  /api/logbook    (Bearer) {dives, deleted, baseUpdatedAt}
 *                        → {updatedAt} | 409 {current doc} on conflict
 *
 * Storage: JSON files under server/data/ (atomic writes).
 * Passwords: scrypt. Sessions: random bearer tokens, 30-day expiry, persisted.
 *
 * Run:  node server/server.js  [PORT=8080]
 * Note: put a TLS-terminating proxy (Caddy, nginx, …) in front for production —
 * credentials must not travel over plain HTTP outside localhost.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'data');
const LOGBOOKS = path.join(DATA, 'logbooks');
const PORT = parseInt(process.env.PORT || '8080', 10);

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 8 * 1024 * 1024; // logbooks with full profiles can be chunky

fs.mkdirSync(LOGBOOKS, { recursive: true });

/* ------------------------------ storage ------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const USERS_FILE = path.join(DATA, 'users.json');
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
let users = readJson(USERS_FILE, {});      // email → {salt, hash, createdAt}
let sessions = readJson(SESSIONS_FILE, {}); // token → {email, expires}

const saveUsers = () => writeJsonAtomic(USERS_FILE, users);
const saveSessions = () => writeJsonAtomic(SESSIONS_FILE, sessions);

const logbookFile = email =>
  path.join(LOGBOOKS, crypto.createHash('sha256').update(email).digest('hex').slice(0, 32) + '.json');

/* ------------------------------- auth -------------------------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { email, expires: Date.now() + TOKEN_TTL_MS };
  // prune expired
  for (const [t, s] of Object.entries(sessions)) if (s.expires < Date.now()) delete sessions[t];
  saveSessions();
  return token;
}

function authenticate(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = sessions[m[1]];
  if (!s || s.expires < Date.now()) return null;
  return { email: s.email, token: m[1] };
}

/* --------------------------- rate limiting ---------------------------- */

const attempts = new Map(); // ip → {count, reset}
function rateLimited(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { count: 0, reset: now + 15 * 60 * 1000 }; attempts.set(ip, a); }
  a.count += 1;
  return a.count > 30;
}

/* ------------------------------ helpers ------------------------------- */

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------- API ---------------------------------- */

async function handleApi(req, res, pathname) {
  const ip = req.socket.remoteAddress || '?';

  if (req.method === 'POST' && (pathname === '/api/register' || pathname === '/api/login')) {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many attempts — try again later.' });
    const { email, password } = await readBody(req);
    const mail = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(mail)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8) {
      return send(res, 400, { error: 'Password must be at least 8 characters.' });
    }

    if (pathname === '/api/register') {
      if (users[mail]) return send(res, 409, { error: 'An account with this email already exists.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[mail] = { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
      saveUsers();
      return send(res, 200, { token: createSession(mail), email: mail });
    }

    const u = users[mail];
    const salt = u ? u.salt : 'x'.repeat(32); // constant-time-ish: always hash
    const hash = hashPassword(password, salt);
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) {
      return send(res, 401, { error: 'Wrong email or password.' });
    }
    return send(res, 200, { token: createSession(mail), email: mail });
  }

  const auth = authenticate(req);
  if (!auth) return send(res, 401, { error: 'Not signed in.' });

  if (req.method === 'POST' && pathname === '/api/logout') {
    delete sessions[auth.token];
    saveSessions();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, { email: auth.email });
  }

  if (pathname === '/api/logbook') {
    const file = logbookFile(auth.email);
    const EMPTY = { dives: [], deleted: [], settings: null, settingsUpdatedAt: null, updatedAt: null };
    if (req.method === 'GET') {
      return send(res, 200, { ...EMPTY, ...readJson(file, {}) });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.dives) || !Array.isArray(body.deleted ?? []) ||
          (body.settings != null && typeof body.settings !== 'object')) {
        return send(res, 400, { error: 'Malformed logbook document.' });
      }
      const current = { ...EMPTY, ...readJson(file, {}) };
      if (current.updatedAt && body.baseUpdatedAt !== current.updatedAt) {
        return send(res, 409, current); // client merges and retries
      }
      const doc = {
        dives: body.dives,
        deleted: (body.deleted || []).slice(-5000),
        settings: body.settings ?? null,
        settingsUpdatedAt: body.settingsUpdatedAt ?? null,
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(file, doc);
      return send(res, 200, { updatedAt: doc.updatedAt });
    }
  }

  return send(res, 404, { error: 'Unknown endpoint.' });
}

/* ----------------------------- static files ---------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.uddf': 'application/xml',
  '.xml': 'application/xml',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  // never serve outside the root, or the server's own directory / repo internals
  if (!file.startsWith(ROOT) ||
      file.startsWith(path.join(ROOT, 'server')) ||
      rel.startsWith('/.')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* -------------------------------- server ------------------------------- */

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Abyss server → http://localhost:${PORT}  (data in ${DATA})`);
});
