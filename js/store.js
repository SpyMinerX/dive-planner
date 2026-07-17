/*
 * store.js — persistence (localStorage) for logbook, settings and tissue state.
 */

const KEY_LOGBOOK = 'abyss.logbook.v1';
const KEY_SETTINGS = 'abyss.settings.v1';
const KEY_DELETED = 'abyss.deleted.v1';

export const DEFAULT_SETTINGS = {
  gfLow: 35,
  gfHigh: 75,
  sacBottom: 20,      // L/min surface-equivalent
  sacDeco: 16,
  descentRate: 18,    // m/min
  ascentRate: 9,
  lastStopDepth: 3,   // m
  surfacePressure: 1.01325, // bar
  ppO2MaxBottom: 1.4,
  ppO2MaxDeco: 1.6,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Persist failed', e);
    return false;
  }
}

/* ------------------------------ settings ------------------------------ */

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(KEY_SETTINGS, {}) };
}

export function saveSettings(s) {
  return write(KEY_SETTINGS, s);
}

/* ------------------------------ logbook ------------------------------- */

/**
 * Logbook entry shape:
 * {
 *   id, datetime (ISO), site, notes, source: 'uddf'|'plan'|'manual',
 *   maxDepth, duration, surfaceIntervalMin,
 *   gases: [{o2, he, name}],
 *   samples: [{t, depth, gasIdx}],
 *   computed: { tissuesEnd: {pN2,pHe,surfaceP}, cns, otu, maxGF, surfacingGF }
 * }
 */
export function loadLogbook() {
  return read(KEY_LOGBOOK, []);
}

export function saveLogbook(dives) {
  return write(KEY_LOGBOOK, dives);
}

export function addDives(newDives) {
  const book = loadLogbook();
  book.push(...newDives);
  book.sort((a, b) => {
    if (a.datetime && b.datetime) return new Date(a.datetime) - new Date(b.datetime);
    return 0;
  });
  saveLogbook(book);
  return book;
}

/** Patch a dive in place; stamps modifiedAt so cloud merges keep the newest edit. */
export function updateDive(id, patch) {
  const book = loadLogbook();
  const i = book.findIndex(d => d.id === id);
  if (i >= 0) {
    book[i] = { ...book[i], ...patch, modifiedAt: new Date().toISOString() };
    saveLogbook(book);
  }
  return book;
}

export function deleteDive(id) {
  const book = loadLogbook().filter(d => d.id !== id);
  saveLogbook(book);
  addTombstones([id]);
  return book;
}

export function clearAll() {
  addTombstones(loadLogbook().map(d => d.id));
  localStorage.removeItem(KEY_LOGBOOK);
}

/* Tombstones: ids of deleted dives, so deletions survive cloud merges. */
export function loadTombstones() {
  return read(KEY_DELETED, []);
}

export function addTombstones(ids) {
  const t = new Set(loadTombstones());
  for (const id of ids) if (id) t.add(id);
  write(KEY_DELETED, [...t].slice(-5000));
}

export function newId() {
  return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
