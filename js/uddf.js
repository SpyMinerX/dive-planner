/*
 * uddf.js — UDDF 3.2 import / export.
 *
 * Import is deliberately forgiving: it matches elements by local name so it
 * works with or without namespaces, and tolerates the field variations that
 * real dive computers emit (seconds vs. minutes, tank vs. mix refs, …).
 */

import { makeGas, gasName } from './deco.js';

/* ---------------------------- helpers ---------------------------- */

function byLocalName(root, name) {
  const out = [];
  const walker = root.getElementsByTagName('*');
  for (const el of walker) if (el.localName.toLowerCase() === name) out.push(el);
  return out;
}

function firstByLocalName(root, name) {
  return byLocalName(root, name)[0] || null;
}

function num(el, name, fallback = null) {
  const child = el ? firstByLocalName(el, name) : null;
  if (!child) return fallback;
  const v = parseFloat(child.textContent.trim());
  return Number.isFinite(v) ? v : fallback;
}

function text(el, name, fallback = '') {
  const child = el ? firstByLocalName(el, name) : null;
  return child ? child.textContent.trim() : fallback;
}

/* ---------------------------- import ----------------------------- */

/**
 * Parse a UDDF document string.
 * @returns {{ dives: ImportedDive[], errors: string[] }}
 * ImportedDive: { id, datetime, site, buddy, notes, maxDepth, duration,
 *                 surfaceIntervalMin, gases: [{o2,he,name}], samples: [{t, depth, gasIdx}] }
 */
export function parseUDDF(xmlString) {
  const errors = [];
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) {
    return { dives: [], errors: ['File is not valid XML.'] };
  }
  const root = doc.documentElement;
  if (root.localName.toLowerCase() !== 'uddf') {
    return { dives: [], errors: [`Root element is <${root.localName}>, expected <uddf>.`] };
  }

  // --- gas definitions ---
  const mixById = new Map();
  const gasdefs = firstByLocalName(root, 'gasdefinitions');
  if (gasdefs) {
    for (const mix of byLocalName(gasdefs, 'mix')) {
      const id = mix.getAttribute('id') || `mix${mixById.size + 1}`;
      let o2 = num(mix, 'o2', 0.21);
      let he = num(mix, 'he', 0);
      if (o2 > 1) o2 /= 100; // some exporters use percent
      if (he > 1) he /= 100;
      const name = text(mix, 'name', '') || gasName(o2, he);
      mixById.set(id, { o2, he, name });
    }
  }

  // --- dive sites (name + GPS) ---
  const siteById = new Map();
  for (const siteEl of byLocalName(root, 'divesite')) {
    const id = siteEl.getAttribute('id');
    if (!id) continue;
    siteById.set(id, {
      name: text(siteEl, 'name', ''),
      lat: num(siteEl, 'latitude', null),
      lon: num(siteEl, 'longitude', null),
    });
  }

  // --- tank → mix indirection (some computers reference tanks, not mixes) ---
  const dives = [];
  const diveEls = byLocalName(root, 'dive');
  let lastEndTime = null;

  for (const diveEl of diveEls) {
    try {
      const before = firstByLocalName(diveEl, 'informationbeforedive');
      const after = firstByLocalName(diveEl, 'informationafterdive');
      const dtText = text(before, 'datetime', '') || text(diveEl, 'datetime', '');
      const datetime = dtText ? new Date(dtText) : null;

      // Per-dive gas list: mixes referenced by tankdata/switchmix, else all defined mixes
      const gases = [];
      const gasIdxByMixId = new Map();
      const ensureGas = (mixId) => {
        if (mixId && gasIdxByMixId.has(mixId)) return gasIdxByMixId.get(mixId);
        const def = mixId ? mixById.get(mixId) : null;
        const g = def ? makeGas(def.o2, def.he, def.name) : makeGas(0.21, 0, 'Air');
        // dedupe by composition
        const existing = gases.findIndex(x => Math.abs(x.o2 - g.o2) < 0.005 && Math.abs(x.he - g.he) < 0.005);
        if (existing >= 0) {
          if (mixId) gasIdxByMixId.set(mixId, existing);
          return existing;
        }
        gases.push(g);
        const idx = gases.length - 1;
        if (mixId) gasIdxByMixId.set(mixId, idx);
        return idx;
      };

      for (const tank of byLocalName(diveEl, 'tankdata')) {
        const link = firstByLocalName(tank, 'link');
        if (link) ensureGas(link.getAttribute('ref'));
      }

      // --- samples ---
      const samplesEl = firstByLocalName(diveEl, 'samples');
      const samples = [];
      let currentGasIdx = gases.length ? 0 : ensureGas(null);
      if (samplesEl) {
        for (const wp of byLocalName(samplesEl, 'waypoint')) {
          const depth = num(wp, 'depth', null);
          const divetimeSec = num(wp, 'divetime', null);
          if (depth == null || divetimeSec == null) continue;
          const sw = firstByLocalName(wp, 'switchmix');
          if (sw) currentGasIdx = ensureGas(sw.getAttribute('ref'));
          samples.push({ t: divetimeSec / 60, depth, gasIdx: currentGasIdx });
        }
      }
      if (!samples.length) {
        // Fall back to a square profile from summary data
        const maxD = num(after, 'greatestdepth', null) ?? num(diveEl, 'greatestdepth', null);
        const durSec = num(after, 'diveduration', null) ?? num(diveEl, 'diveduration', null);
        if (maxD != null && durSec != null) {
          const durMin = durSec / 60;
          const gi = currentGasIdx;
          samples.push({ t: 0, depth: 0, gasIdx: gi });
          samples.push({ t: Math.min(maxD / 18, durMin * 0.2), depth: maxD, gasIdx: gi });
          samples.push({ t: Math.max(durMin - maxD / 9, durMin * 0.8), depth: maxD, gasIdx: gi });
          samples.push({ t: durMin, depth: 0, gasIdx: gi });
        } else {
          errors.push(`Dive "${diveEl.getAttribute('id') || dives.length + 1}" has no samples and no summary depth/duration — skipped.`);
          continue;
        }
      }

      const maxDepth = num(after, 'greatestdepth', null) ?? Math.max(...samples.map(s => s.depth));
      const durationMin = (num(after, 'diveduration', null) ?? null) != null
        ? num(after, 'diveduration') / 60
        : samples[samples.length - 1].t;

      // surface interval: explicit element, or derived from timestamps
      let siMin = null;
      const siEl = before ? firstByLocalName(before, 'surfaceintervalbeforedive') : null;
      if (siEl) {
        const passed = num(siEl, 'passedtime', null);
        if (passed != null) siMin = passed / 60;
        else if (firstByLocalName(siEl, 'infinity')) siMin = Infinity;
      }
      if (siMin == null && datetime && lastEndTime) {
        siMin = Math.max(0, (datetime - lastEndTime) / 60000);
      }
      if (datetime) lastEndTime = new Date(datetime.getTime() + durationMin * 60000);

      // dive site: resolve <link ref> under informationbeforedive against divesite defs
      let site = text(before, 'divesitename', '');
      let gps = null;
      if (before) {
        for (const link of byLocalName(before, 'link')) {
          const s = siteById.get(link.getAttribute('ref'));
          if (s) {
            site = s.name || site;
            if (s.lat != null && s.lon != null) gps = { lat: s.lat, lon: s.lon };
            break;
          }
        }
      }

      dives.push({
        id: diveEl.getAttribute('id') || `dive-${dives.length + 1}`,
        datetime: datetime && !isNaN(datetime) ? datetime.toISOString() : null,
        site,
        gps,
        notes: text(firstByLocalName(diveEl, 'notes'), 'para', ''),
        maxDepth,
        duration: durationMin,
        surfaceIntervalMin: siMin === Infinity ? null : siMin,
        gases,
        samples,
      });
    } catch (e) {
      errors.push(`Failed to parse a dive: ${e.message}`);
    }
  }

  // chronological order (oldest first) so tissue chaining works
  dives.sort((a, b) => {
    if (a.datetime && b.datetime) return new Date(a.datetime) - new Date(b.datetime);
    return 0;
  });

  if (!dives.length && !errors.length) errors.push('No dives found in this UDDF file.');
  return { dives, errors };
}

/* ---------------------------- export ----------------------------- */

const esc = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/**
 * Serialise logbook dives to a UDDF 3.2 document.
 * @param dives array of logbook entries ({ datetime, site, notes, gases, samples, ... })
 */
export function exportUDDF(dives, generatorName = 'Abyss Dive Planner') {
  // Collect unique mixes across all dives
  const mixes = [];
  const mixKey = g => `${Math.round(g.o2 * 1000)}/${Math.round(g.he * 1000)}`;
  const mixIdByKey = new Map();
  for (const d of dives) {
    for (const g of d.gases || []) {
      const k = mixKey(g);
      if (!mixIdByKey.has(k)) {
        const id = `mix-${mixes.length + 1}`;
        mixIdByKey.set(k, id);
        mixes.push({ id, ...g });
      }
    }
  }

  const mixXml = mixes.map(m => `    <mix id="${m.id}">
      <name>${esc(m.name || gasName(m.o2, m.he))}</name>
      <o2>${m.o2.toFixed(3)}</o2>
      <n2>${Math.max(0, 1 - m.o2 - m.he).toFixed(3)}</n2>
      <he>${(m.he || 0).toFixed(3)}</he>
    </mix>`).join('\n');

  // Unique dive sites (name and/or GPS)
  const sites = [];
  const siteKey = d => `${d.site || ''}|${d.gps ? d.gps.lat.toFixed(5) + ',' + d.gps.lon.toFixed(5) : ''}`;
  const siteIdByKey = new Map();
  for (const d of dives) {
    if (!d.site && !d.gps) continue;
    const k = siteKey(d);
    if (!siteIdByKey.has(k)) {
      const id = `site-${sites.length + 1}`;
      siteIdByKey.set(k, id);
      sites.push({ id, name: d.site || 'Unnamed site', gps: d.gps || null });
    }
  }
  const sitesXml = sites.length ? `  <divesitedata>
${sites.map(s => `    <divesite id="${s.id}">
      <name>${esc(s.name)}</name>${s.gps ? `
      <geography><latitude>${s.gps.lat.toFixed(6)}</latitude><longitude>${s.gps.lon.toFixed(6)}</longitude></geography>` : ''}
    </divesite>`).join('\n')}
  </divesitedata>\n` : '';

  const divesXml = dives.map((d, i) => {
    const gasIds = (d.gases || []).map(g => mixIdByKey.get(mixKey(g)));
    let lastGasIdx = -1;
    const wps = (d.samples || []).map(s => {
      const sw = s.gasIdx !== lastGasIdx && gasIds[s.gasIdx]
        ? `<switchmix ref="${gasIds[s.gasIdx]}"/>` : '';
      lastGasIdx = s.gasIdx;
      return `        <waypoint><depth>${s.depth.toFixed(1)}</depth><divetime>${Math.round(s.t * 60)}</divetime>${sw}</waypoint>`;
    }).join('\n');

    const si = d.surfaceIntervalMin != null
      ? `<surfaceintervalbeforedive><passedtime>${Math.round(d.surfaceIntervalMin * 60)}</passedtime></surfaceintervalbeforedive>`
      : '<surfaceintervalbeforedive><infinity/></surfaceintervalbeforedive>';

    const siteRef = siteIdByKey.get(siteKey(d));
    return `      <dive id="${esc(d.id || `dive-${i + 1}`)}">
        <informationbeforedive>
          ${d.datetime ? `<datetime>${esc(d.datetime)}</datetime>` : ''}
          ${siteRef ? `<link ref="${siteRef}"/>` : ''}
          ${si}
        </informationbeforedive>
        <samples>
${wps}
        </samples>
        <informationafterdive>
          <greatestdepth>${(d.maxDepth ?? 0).toFixed(1)}</greatestdepth>
          <diveduration>${Math.round((d.duration ?? 0) * 60)}</diveduration>
          ${d.notes ? `<notes><para>${esc(d.notes)}</para></notes>` : ''}
        </informationafterdive>
      </dive>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<uddf xmlns="http://www.streit.cc/uddf/3.2/" version="3.2.0">
  <generator>
    <name>${esc(generatorName)}</name>
    <datetime>${new Date().toISOString()}</datetime>
    <type>logbook</type>
  </generator>
  <gasdefinitions>
${mixXml}
  </gasdefinitions>
${sitesXml}  <profiledata>
    <repetitiongroup id="rg-1">
${divesXml}
    </repetitiongroup>
  </profiledata>
</uddf>`;
}
