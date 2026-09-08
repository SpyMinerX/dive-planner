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
 *   GET  /api/updates    (SSE, no auth) → {bootId} on connect, then pings.
 *                        A client that sees bootId change (only possible via
 *                        a reconnect, since the id is fixed for the process's
 *                        life) knows the server restarted — i.e. a new
 *                        version was deployed — and prompts to refresh.
 *   POST /api/share      (Bearer) {dive}                → {id}
 *   GET  /api/share/:id  (no auth)                       → {dive, sharedBy, createdAt} | 404
 *                        A dive plan shared by link — readable by anyone who
 *                        has the (unguessable) id, expires after 90 days.
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
const SHARES = path.join(DATA, 'shares');
const PORT = parseInt(process.env.PORT || '8080', 10);

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const SHARE_TTL_MS = 90 * 24 * 3600 * 1000;
const MAX_BODY = 8 * 1024 * 1024; // logbooks with full profiles can be chunky

fs.mkdirSync(LOGBOOKS, { recursive: true });
fs.mkdirSync(SHARES, { recursive: true });

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

const SHARE_ID_RE = /^[a-f0-9]{32}$/;
const shareFile = id => path.join(SHARES, id + '.json');

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

/* ------------------------- live update notifications ------------------- */

// A random id fixed for this process's whole life. Clients hold an SSE
// connection open (EventSource, which reconnects on its own) and compare the
// id across reconnects — a changed value only happens if the server process
// itself restarted, which is exactly the "a new version was deployed" signal,
// pushed the moment it reconnects rather than waited out on a poll interval.
const BOOT_ID = crypto.randomBytes(8).toString('hex');
const sseClients = new Set();
const SSE_PING_MS = 25000; // keep intermediate proxies from timing out the connection

function handleUpdatesStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // ask nginx not to buffer an SSE response
  });
  res.write(`data: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client gone */ } }, SSE_PING_MS);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
}

function closeAllSseClients() {
  for (const res of sseClients) { try { res.end(); } catch { /* already gone */ } }
  sseClients.clear();
}

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

  // shared plan links are readable by anyone holding the (unguessable) id —
  // no account needed, so this must come before the auth gate below.
  if (req.method === 'GET' && pathname.startsWith('/api/share/')) {
    const id = pathname.slice('/api/share/'.length);
    if (!SHARE_ID_RE.test(id)) return send(res, 404, { error: 'This share link is invalid.' });
    const doc = readJson(shareFile(id), null);
    if (!doc) return send(res, 404, { error: 'This share link is invalid or has expired.' });
    if (Date.now() - new Date(doc.createdAt).getTime() > SHARE_TTL_MS) {
      try { fs.unlinkSync(shareFile(id)); } catch { /* already gone */ }
      return send(res, 404, { error: 'This share link has expired.' });
    }
    return send(res, 200, doc);
  }

  const auth = authenticate(req);
  if (!auth) return send(res, 401, { error: 'Not signed in.' });

  if (req.method === 'POST' && pathname === '/api/share') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !body.dive || typeof body.dive !== 'object') {
      return send(res, 400, { error: 'Malformed share request.' });
    }
    const id = crypto.randomBytes(16).toString('hex');
    writeJsonAtomic(shareFile(id), { dive: body.dive, sharedBy: auth.email, createdAt: new Date().toISOString() });
    return send(res, 200, { id });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    delete sessions[auth.token];
    saveSessions();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, { email: auth.email });
  }

  // cheap change-detection for client polling: just the document stamp
  if (req.method === 'GET' && pathname === '/api/logbook/meta') {
    const doc = readJson(logbookFile(auth.email), {});
    return send(res, 200, { updatedAt: doc.updatedAt ?? null });
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

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  try {
    if (pathname === '/api/updates' && req.method === 'GET') return handleUpdatesStream(req, res);
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// close SSE connections promptly so a container stop/restart (i.e. a deploy)
// isn't held up waiting on long-lived keep-alive streams.
function shutdown() {
  closeAllSseClients();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`Abyss server → http://localhost:${PORT}  (data in ${DATA})`);
});
