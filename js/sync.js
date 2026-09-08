/*
 * sync.js — account + cloud logbook sync.
 *
 * Offline-first: localStorage remains the source of truth; when signed in,
 * the logbook is merged with the server copy (union by dive id, minus
 * tombstoned deletions) and pushed back. Conflicts (409) are resolved by
 * re-merging against the server's current document and retrying once.
 */

const KEY_ACCOUNT = 'abyss.account.v1';

export function getAccount() {
  try {
    return JSON.parse(localStorage.getItem(KEY_ACCOUNT)) || null;
  } catch {
    return null;
  }
}

function saveAccount(acc) {
  if (acc) localStorage.setItem(KEY_ACCOUNT, JSON.stringify(acc));
  else localStorage.removeItem(KEY_ACCOUNT);
}

async function api(path, { method = 'GET', body, token } = {}) {
  let resp;
  try {
    resp = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('offline', 'Cloud server unreachable — working locally.');
  }
  let data = {};
  try { data = await resp.json(); } catch { /* empty body */ }
  if (!resp.ok) {
    if (resp.status === 401 && token) throw new SyncError('expired', 'Session expired — sign in again.');
    if (resp.status === 409) throw new SyncError('conflict', 'Logbook changed on another device.', data);
    throw new SyncError('error', data.error || `Request failed (${resp.status}).`);
  }
  return data;
}

export class SyncError extends Error {
  constructor(kind, message, payload = null) {
    super(message);
    this.kind = kind;
    this.payload = payload;
  }
}

export async function register(email, password) {
  const { token } = await api('/api/register', { method: 'POST', body: { email, password } });
  saveAccount({ token, email: email.trim().toLowerCase() });
  return getAccount();
}

export async function login(email, password) {
  const { token } = await api('/api/login', { method: 'POST', body: { email, password } });
  saveAccount({ token, email: email.trim().toLowerCase() });
  return getAccount();
}

export async function logout() {
  const acc = getAccount();
  saveAccount(null);
  if (acc) {
    try { await api('/api/logout', { method: 'POST', token: acc.token }); } catch { /* best effort */ }
  }
}

export function dropAccount() {
  saveAccount(null);
}

/** Cheap poll: just the server document stamp, for change detection. */
export async function remoteMeta() {
  const acc = getAccount();
  if (!acc) throw new SyncError('error', 'Not signed in.');
  return api('/api/logbook/meta', { token: acc.token });
}

/* ------------------------------ dive sharing ---------------------------- */

/** Publish a dive plan (a curated subset — see app.js) behind an unguessable link. Returns its id. */
export async function createShare(dive) {
  const acc = getAccount();
  if (!acc) throw new SyncError('error', 'Not signed in.');
  const { id } = await api('/api/share', { method: 'POST', token: acc.token, body: { dive } });
  return id;
}

/** Fetch a shared dive plan by id — no account needed, so this works for a signed-out visitor. */
export async function fetchShare(id) {
  return api(`/api/share/${encodeURIComponent(id)}`);
}

/* --------------------------- update notifications ----------------------- */

/**
 * Subscribes to the server's live update stream. Calls onUpdate() the first
 * time the server's boot id changes after the initial connection — that only
 * happens if the process restarted (a deploy), so it's a real server-pushed
 * "a new version is available" signal rather than a client-side poll.
 * No account/auth needed. Returns an unsubscribe function.
 */
export function subscribeToUpdates(onUpdate) {
  if (typeof EventSource === 'undefined') return () => {};
  let knownBootId = null;
  const es = new EventSource('/api/updates');
  es.onmessage = ev => {
    try {
      const { bootId } = JSON.parse(ev.data);
      if (knownBootId == null) knownBootId = bootId;
      else if (bootId !== knownBootId) onUpdate();
    } catch { /* ignore a malformed frame */ }
  };
  // EventSource retries the connection on its own — nothing to do here.
  return () => es.close();
}

/* ------------------------------ merging ------------------------------- */

/**
 * Union by dive id, minus deletions, chronological. On id collisions the copy
 * with the newer modifiedAt stamp wins (unstamped remote loses to local).
 */
export function mergeLogbooks(localDives, remoteDives, deletedIds) {
  const dead = new Set(deletedIds);
  const byId = new Map();
  for (const d of remoteDives || []) if (d && d.id && !dead.has(d.id)) byId.set(d.id, d);
  for (const d of localDives || []) {
    if (!d || !d.id || dead.has(d.id)) continue;
    const remote = byId.get(d.id);
    if (remote && remote.modifiedAt && d.modifiedAt &&
        new Date(remote.modifiedAt) > new Date(d.modifiedAt)) continue;
    byId.set(d.id, d);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.datetime && b.datetime) return new Date(a.datetime) - new Date(b.datetime);
    return 0;
  });
}

/**
 * Full sync: pull, merge, push. Syncs the dive list (union by id + tombstones)
 * and the deco settings (whole-object, newest edit timestamp wins).
 * Returns { dives, deleted, changed, settings, settingsAt, settingsChanged } —
 * `changed`/`settingsChanged` flag when the merged result differs from local input.
 * Throws SyncError('offline'|'expired'|'error') on failure.
 */
export async function syncLogbook(localDives, localDeleted, localSettings = null, localSettingsAt = null) {
  const acc = getAccount();
  if (!acc) throw new SyncError('error', 'Not signed in.');

  let remote = await api('/api/logbook', { token: acc.token });

  for (let attempt = 0; attempt < 2; attempt++) {
    const deleted = [...new Set([...(remote.deleted || []), ...(localDeleted || [])])];
    const merged = mergeLogbooks(localDives, remote.dives, deleted);

    // settings: the copy with the newer edit timestamp wins
    let settings = localSettings, settingsAt = localSettingsAt, settingsChanged = false;
    if (remote.settings && remote.settingsUpdatedAt &&
        (!localSettingsAt || new Date(remote.settingsUpdatedAt) > new Date(localSettingsAt))) {
      settings = remote.settings;
      settingsAt = remote.settingsUpdatedAt;
      settingsChanged = JSON.stringify(remote.settings) !== JSON.stringify(localSettings);
    }

    try {
      const put = await api('/api/logbook', {
        method: 'PUT',
        token: acc.token,
        body: {
          dives: merged, deleted,
          settings, settingsUpdatedAt: settingsAt,
          baseUpdatedAt: remote.updatedAt ?? null,
        },
      });
      // dives are merged by id+modifiedAt, so content edits count as changes too
      const localKeys = (localDives || []).map(d => `${d.id}@${d.modifiedAt || ''}`).join(',');
      const mergedKeys = merged.map(d => `${d.id}@${d.modifiedAt || ''}`).join(',');
      return {
        dives: merged, deleted, changed: localKeys !== mergedKeys,
        settings, settingsAt, settingsChanged,
        serverUpdatedAt: put.updatedAt ?? null,
      };
    } catch (e) {
      if (e.kind === 'conflict' && attempt === 0) { remote = e.payload; continue; }
      throw e;
    }
  }
  throw new SyncError('error', 'Sync failed after conflict retry.');
}
