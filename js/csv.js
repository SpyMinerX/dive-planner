/*
 * csv.js — generic CSV dive-profile import.
 *
 * There's no single standard CSV layout across dive computers/logging apps,
 * so this looks for plausible columns by header name (several common
 * spellings and units) instead of assuming one fixed schema, and treats each
 * file as one dive. When a time column's unit isn't stated in its header,
 * it's assumed to be seconds — the overwhelmingly common raw-sample
 * convention (and what UDDF itself uses internally).
 */

import { makeGas } from './deco.js';

function detectDelimiter(line) {
  const counts = { ',': count(line, ','), ';': count(line, ';'), '\t': count(line, '\t') };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}
function count(s, ch) { return s.split(ch).length - 1; }

/** Split one CSV line on `delim`, honoring double-quoted fields (with "" escaping). */
function splitLine(line, delim) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** What a header column probably holds, and in what unit. */
function classifyColumn(header) {
  const h = header.toLowerCase().replace(/[_-]/g, ' ').trim();
  if (/^(elapsed )?(time|dive time|runtime|timestamp)\b/.test(h)) {
    let unit = null;
    if (/\(\s*s(ec(onds?)?)?\s*\)|\bsec(onds?)?\b/.test(h)) unit = 's';
    else if (/\(\s*min(ute)?s?\s*\)|\bmin(ute)?s?\b/.test(h)) unit = 'min';
    return { kind: 'time', unit };
  }
  if (/^depth\b/.test(h)) return { kind: 'depth', unit: /\bft\b|\bfeet\b/.test(h) ? 'ft' : 'm' };
  if (/^(o2|fo2|o2 ?%|gas ?o2)\b/.test(h)) return { kind: 'o2' };
  if (/^date\b/.test(h)) return { kind: 'date' };
  return null;
}

/** "12:34" or "1:02:03" → seconds. Returns null if it doesn't look like a clock value. */
function clockToSeconds(cell) {
  if (!/^\d{1,3}(:\d{1,2}){1,2}$/.test(cell)) return null;
  const parts = cell.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

/**
 * Parse a CSV dive-profile export.
 * @returns {{ dives: ImportedDive[], errors: string[] }} — same shape as parseUDDF.
 */
export function parseCSV(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
  if (lines.length < 2) return { dives: [], errors: ['CSV file has no data rows.'] };

  const delim = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delim);
  const cols = header.map(classifyColumn);

  const timeIdx = cols.findIndex(c => c?.kind === 'time');
  const depthIdx = cols.findIndex(c => c?.kind === 'depth');
  if (timeIdx === -1 || depthIdx === -1) {
    return {
      dives: [], errors: [
        'Could not find recognizable time/depth columns in this CSV — expected headers ' +
        'like "Time (s)" and "Depth (m)" (or "Depth (ft)").',
      ],
    };
  }
  const timeUnit = cols[timeIdx].unit;
  const depthUnit = cols[depthIdx].unit;
  const o2Idx = cols.findIndex(c => c?.kind === 'o2');
  const dateIdx = cols.findIndex(c => c?.kind === 'date');

  const raw = [];
  let dateText = null;
  let o2Pct = null;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    if (cells.length <= Math.max(timeIdx, depthIdx)) continue;
    if (dateIdx >= 0 && !dateText && cells[dateIdx]) dateText = cells[dateIdx];
    if (o2Idx >= 0 && o2Pct == null) {
      const v = parseFloat(cells[o2Idx]);
      if (Number.isFinite(v)) o2Pct = v;
    }

    const tCell = cells[timeIdx];
    let tSec = clockToSeconds(tCell);
    if (tSec == null) {
      const v = parseFloat(tCell);
      if (!Number.isFinite(v)) continue;
      tSec = timeUnit === 'min' ? v * 60 : v; // unstated unit defaults to seconds
    }
    const dCell = parseFloat(cells[depthIdx]);
    if (!Number.isFinite(dCell)) continue;
    const depth = Math.max(0, depthUnit === 'ft' ? dCell * 0.3048 : dCell);
    raw.push({ t: tSec / 60, depth });
  }
  if (raw.length < 2) return { dives: [], errors: ['No usable depth/time rows found in this CSV.'] };

  raw.sort((a, b) => a.t - b.t);
  const t0 = raw[0].t;
  const samples = raw.map(s => ({ t: +(s.t - t0).toFixed(3), depth: +s.depth.toFixed(1), gasIdx: 0 }));

  const o2 = o2Pct != null ? (o2Pct > 1 ? o2Pct / 100 : o2Pct) : 0.21;
  const gas = makeGas(o2, 0);

  let datetime = null;
  if (dateText) {
    const d = new Date(dateText);
    if (!isNaN(d)) datetime = d.toISOString();
  }

  return {
    dives: [{
      id: null,
      datetime,
      site: '',
      gps: null,
      buddy: '',
      notes: '',
      maxDepth: Math.max(...samples.map(s => s.depth)),
      duration: samples[samples.length - 1].t,
      surfaceIntervalMin: null,
      gases: [{ o2: gas.o2, he: gas.he, name: gas.name }],
      samples,
    }],
    errors: [],
  };
}
