/*
 * server.js — Abyss cloud server (Node 20+, PostgreSQL via `pg`).
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
 *                        bootId is a fingerprint of the deployed app files, so
 *                        every replica of one release reports the same value.
 *                        A client that sees it change across a reconnect knows
 *                        a new version was deployed and prompts to refresh.
 *   POST /api/share      (Bearer) {dive}                → {id}
 *   GET  /api/share/:id  (no auth)                       → {dive, sharedBy, createdAt} | 404
 *                        A dive plan shared by link — readable by anyone who
 *                        has the (unguessable) id, expires after 90 days.
 *   GET  /healthz        → 200 ok | 503 when the database is unreachable
 *
 * Storage: PostgreSQL (see db.js). The container itself is stateless, so any
 * number of replicas can run side by side.
 * Passwords: scrypt. Sessions: random bearer tokens, 30-day expiry, persisted.
 *
 * Run:  node server/server.js  [PORT=8080, DB_* or DATABASE_URL]
 * Note: put a TLS-terminating proxy (Caddy, nginx, Traefik, …) in front for
 * production — credentials must not travel over plain HTTP outside localhost.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, tx, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8080', 10);
// behind Traefik/Cloudflare the socket address is the proxy's, not the client's
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const SHARE_TTL_MS = 90 * 24 * 3600 * 1000;
const MAX_BODY = 8 * 1024 * 1024; // logbooks with full profiles can be chunky

const SHARE_ID_RE = /^[a-f0-9]{32}$/;

/* ------------------------------- auth -------------------------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO sessions (token, email, expires) VALUES ($1, $2, $3)',
    [token, email, new Date(Date.now() + TOKEN_TTL_MS)]);
  await query('DELETE FROM sessions WHERE expires < now()'); // prune expired
  return token;
}

async function authenticate(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const { rows } = await query('SELECT email FROM sessions WHERE token = $1 AND expires > now()', [m[1]]);
  return rows[0] ? { email: rows[0].email, token: m[1] } : null;
}

/* --------------------------- rate limiting ---------------------------- */

// per replica — good enough to blunt password guessing
const attempts = new Map(); // ip → {count, reset}
function rateLimited(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { count: 0, reset: now + 15 * 60 * 1000 }; attempts.set(ip, a); }
  a.count += 1;
  return a.count > 30;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
}, 15 * 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
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

// A fingerprint of the app files in this image (or APP_VERSION if set). It is
// identical on every replica of a release — so a client reconnecting to a
// different replica isn't told to refresh — and changes when a new version is
// deployed. Clients hold an SSE connection open (EventSource reconnects on its
// own) and compare the id across reconnects.
function releaseId() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const h = crypto.createHash('sha256');
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(ROOT, p)); h.update(fs.readFileSync(p)); }
    }
  };
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'package.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) { h.update(f); h.update(fs.readFileSync(p)); }
  }
  for (const d of ['css', 'js', 'icons']) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) walk(p);
  }
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).sort()) {
    h.update(f); h.update(fs.readFileSync(path.join(__dirname, f)));
  }
  return h.digest('hex').slice(0, 16);
}
const BOOT_ID = releaseId();
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

const EMPTY_LOGBOOK = { dives: [], deleted: [], settings: null, settingsUpdatedAt: null, updatedAt: null };

/**
 * Optimistic-concurrency write of a logbook: succeeds only if the client based
 * its edit on the stored version. The row lock makes the check-and-write
 * atomic across replicas. Returns {updatedAt} or {conflict: currentDoc}.
 */
function putLogbook(email, body) {
  return tx(async c => {
    const { rows } = await c.query('SELECT doc FROM logbooks WHERE email = $1 FOR UPDATE', [email]);
    const current = { ...EMPTY_LOGBOOK, ...(rows[0]?.doc || {}) };
    if (current.updatedAt && body.baseUpdatedAt !== current.updatedAt) return { conflict: current };
    const doc = {
      dives: body.dives,
      deleted: (body.deleted || []).slice(-5000),
      settings: body.settings ?? null,
      settingsUpdatedAt: body.settingsUpdatedAt ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (rows[0]) {
      await c.query('UPDATE logbooks SET doc = $2 WHERE email = $1', [email, JSON.stringify(doc)]);
    } else {
      // first write for this account: a concurrent first write on another
      // replica may have won the insert — then it's a normal conflict
      const r = await c.query('INSERT INTO logbooks (email, doc) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
        [email, JSON.stringify(doc)]);
      if (r.rowCount === 0) {
        const again = await c.query('SELECT doc FROM logbooks WHERE email = $1', [email]);
        return { conflict: { ...EMPTY_LOGBOOK, ...again.rows[0].doc } };
      }
    }
    return { updatedAt: doc.updatedAt };
  });
}

async function handleApi(req, res, pathname) {
  const ip = clientIp(req);

  if (req.method === 'POST' && (pathname === '/api/register' || pathname === '/api/login')) {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many attempts — try again later.' });
    const { email, password } = await readBody(req);
    const mail = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(mail)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8) {
      return send(res, 400, { error: 'Password must be at least 8 characters.' });
    }

    if (pathname === '/api/register') {
      const salt = crypto.randomBytes(16).toString('hex');
      const r = await query('INSERT INTO users (email, salt, hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [mail, salt, hashPassword(password, salt)]);
      if (r.rowCount === 0) return send(res, 409, { error: 'An account with this email already exists.' });
      return send(res, 200, { token: await createSession(mail), email: mail });
    }

    const { rows } = await query('SELECT salt, hash FROM users WHERE email = $1', [mail]);
    const u = rows[0];
    const salt = u ? u.salt : 'x'.repeat(32); // constant-time-ish: always hash
    const hash = hashPassword(password, salt);
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) {
      return send(res, 401, { error: 'Wrong email or password.' });
    }
    return send(res, 200, { token: await createSession(mail), email: mail });
  }

  // shared plan links are readable by anyone holding the (unguessable) id —
  // no account needed, so this must come before the auth gate below.
  if (req.method === 'GET' && pathname.startsWith('/api/share/')) {
    const id = pathname.slice('/api/share/'.length);
    if (!SHARE_ID_RE.test(id)) return send(res, 404, { error: 'This share link is invalid.' });
    const { rows } = await query('SELECT dive, shared_by, created_at FROM shares WHERE id = $1', [id]);
    const s = rows[0];
    if (!s) return send(res, 404, { error: 'This share link is invalid or has expired.' });
    if (Date.now() - s.created_at.getTime() > SHARE_TTL_MS) {
      await query('DELETE FROM shares WHERE id = $1', [id]);
      return send(res, 404, { error: 'This share link has expired.' });
    }
    return send(res, 200, { dive: s.dive, sharedBy: s.shared_by, createdAt: s.created_at.toISOString() });
  }

  const auth = await authenticate(req);
  if (!auth) return send(res, 401, { error: 'Not signed in.' });

  if (req.method === 'POST' && pathname === '/api/share') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !body.dive || typeof body.dive !== 'object') {
      return send(res, 400, { error: 'Malformed share request.' });
    }
    const id = crypto.randomBytes(16).toString('hex');
    await query('INSERT INTO shares (id, dive, shared_by) VALUES ($1, $2, $3)',
      [id, JSON.stringify(body.dive), auth.email]);
    return send(res, 200, { id });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    await query('DELETE FROM sessions WHERE token = $1', [auth.token]);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, { email: auth.email });
  }

  // cheap change-detection for client polling: just the document stamp
  if (req.method === 'GET' && pathname === '/api/logbook/meta') {
    const { rows } = await query("SELECT doc->>'updatedAt' AS updated_at FROM logbooks WHERE email = $1", [auth.email]);
    return send(res, 200, { updatedAt: rows[0]?.updated_at ?? null });
  }

  if (pathname === '/api/logbook') {
    if (req.method === 'GET') {
      const { rows } = await query('SELECT doc FROM logbooks WHERE email = $1', [auth.email]);
      return send(res, 200, { ...EMPTY_LOGBOOK, ...(rows[0]?.doc || {}) });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.dives) || !Array.isArray(body.deleted ?? []) ||
          (body.settings != null && typeof body.settings !== 'object')) {
        return send(res, 400, { error: 'Malformed logbook document.' });
      }
      const result = await putLogbook(auth.email, body);
      if (result.conflict) return send(res, 409, result.conflict); // client merges and retries
      return send(res, 200, { updatedAt: result.updatedAt });
    }
  }

  return send(res, 404, { error: 'Unknown endpoint.' });
}

/* ------------------------------ health -------------------------------- */

async function handleHealth(res) {
  try {
    await query('SELECT 1');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('ok');
  } catch (e) {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('database unavailable');
  }
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

// server code, dependencies and tooling are never served
const PRIVATE_DIRS = ['server', 'node_modules', 'scripts'].map(d => path.join(ROOT, d));
const PRIVATE_FILES = ['package.json', 'package-lock.json'].map(f => path.join(ROOT, f));

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  // never serve outside the root, or the server's own directory / repo internals
  if (!file.startsWith(ROOT + path.sep) ||
      PRIVATE_DIRS.some(d => file === d || file.startsWith(d + path.sep)) ||
      PRIVATE_FILES.includes(file) ||
      rel.startsWith('/.')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* -------------------------------- server ------------------------------- */

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  try {
    if (pathname === '/healthz') return await handleHealth(res);
    if (pathname === '/api/updates' && req.method === 'GET') return handleUpdatesStream(req, res);
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    // database trouble (e.g. mid-failover) is a server-side, retryable error
    if (e.code || /connect|terminat|timeout/i.test(e.message)) {
      console.warn(`${req.method} ${pathname}: ${e.message}`);
      send(res, 503, { error: 'Server temporarily unavailable — try again.' });
    } else {
      send(res, 400, { error: e.message });
    }
  }
});

// hourly cleanup of expired sessions and share links; idempotent, so it's
// harmless when every replica runs it
setInterval(() => {
  query('DELETE FROM sessions WHERE expires < now()').catch(() => {});
  query(`DELETE FROM shares WHERE created_at < now() - interval '${SHARE_TTL_MS / 1000} seconds'`).catch(() => {});
}, 3600 * 1000).unref();

// close SSE connections promptly so a container stop/restart (i.e. a deploy)
// isn't held up waiting on long-lived keep-alive streams; then drain the pool.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received — shutting down`);
  closeAllSseClients();
  server.close(() => pool.end().finally(() => process.exit(0)));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await initDb();
server.listen(PORT, () => {
  console.log(`Abyss server → http://localhost:${PORT}  (release ${BOOT_ID})`);
});
