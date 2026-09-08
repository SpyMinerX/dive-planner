/*
 * fit.js — Garmin FIT (.fit) dive import (e.g. Descent Mk1/2/3).
 *
 * The FIT container format — header, CRC, definition/data messages, base
 * types — is a stable, published part of the ANT+/Garmin spec and is
 * decoded exactly below. What is NOT decoded from a fixed spec is *which*
 * field in the per-second "record" message holds depth: that mapping lives
 * in Garmin's field-definition dictionary, which isn't something we can
 * verify offline. Rather than hard-code a field number we can't confirm
 * (and risk silently wrong depths feeding a decompression calculation),
 * this scans every numeric field across the dive's records and picks
 * whichever one — at whichever common FIT scale (1, 10, 100, 1000) —
 * actually traces a plausible surface → depth → surface profile, and
 * refuses the import outright if nothing does. If a real export doesn't
 * import cleanly, that heuristic is the first thing to revisit.
 */

import { makeGas } from './deco.js';

const RECORD_MESG_NUM = 20;   // stable across the FIT spec: the per-sample message
const TIMESTAMP_FIELD = 253;  // stable across the FIT spec: the universal timestamp field
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31); // FIT timestamps are seconds since 1989-12-31 UTC

// base_type byte -> { size, signed, float, string, wide (needs >32-bit read) }
const BASE_TYPE = {
  0x00: { size: 1, signed: false },
  0x01: { size: 1, signed: true },
  0x02: { size: 1, signed: false },
  0x83: { size: 2, signed: true },
  0x84: { size: 2, signed: false },
  0x85: { size: 4, signed: true },
  0x86: { size: 4, signed: false },
  0x07: { size: 1, signed: false, string: true },
  0x88: { size: 4, signed: false, float: true },
  0x89: { size: 8, signed: false, float: true },
  0x0a: { size: 1, signed: false },
  0x8b: { size: 2, signed: false },
  0x8c: { size: 4, signed: false },
  0x0d: { size: 1, signed: false },
  0x8e: { size: 8, signed: true, wide: true },
  0x8f: { size: 8, signed: false, wide: true },
  0x90: { size: 8, signed: false, wide: true },
};

function readField(view, off, declaredSize, baseType, little) {
  const bt = BASE_TYPE[baseType];
  const n = bt ? bt.size : declaredSize; // trust the declared size even for an unrecognized base type
  if (off + n > view.byteLength) return { value: null, size: Math.max(n, declaredSize) };
  if (!bt) return { value: null, size: declaredSize }; // unknown type — skip its bytes, no value
  if (bt.string) {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = view.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return { value: s, size: n };
  }
  if (bt.float) return { value: n === 4 ? view.getFloat32(off, little) : view.getFloat64(off, little), size: n };
  if (bt.wide) {
    // 64-bit — this app never needs more than double precision out of it
    const lo = little ? view.getUint32(off, true) : view.getUint32(off + 4, false);
    const hi = little ? view.getUint32(off + 4, true) : view.getUint32(off, false);
    return { value: hi * 2 ** 32 + lo, size: n };
  }
  let value;
  if (n === 1) value = bt.signed ? view.getInt8(off) : view.getUint8(off);
  else if (n === 2) value = bt.signed ? view.getInt16(off, little) : view.getUint16(off, little);
  else value = bt.signed ? view.getInt32(off, little) : view.getUint32(off, little);
  return { value, size: n };
}

function readHeader(view) {
  const headerSize = view.getUint8(0);
  if (headerSize < 12) throw new Error('Not a valid FIT file (unexpected header size).');
  const sig = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (sig !== '.FIT') throw new Error('Not a FIT file (missing the ".FIT" signature).');
  return { headerSize, dataSize: view.getUint32(4, true) };
}

/** Walk every "record" message in the file. Stops cleanly (rather than throwing) on a desynced/truncated stream. */
function readRecordMessages(view, header) {
  const records = [];
  const localDefs = new Map();
  let lastTimestamp = null;
  let offset = header.headerSize;
  const end = Math.min(view.byteLength - 2 /* trailing file CRC */, header.headerSize + header.dataSize);

  while (offset < end) {
    const headerByte = view.getUint8(offset); offset += 1;

    if (headerByte & 0x80) { // compressed-timestamp data message
      const localType = (headerByte >> 5) & 0x03;
      const def = localDefs.get(localType);
      if (!def) break;
      if (lastTimestamp != null) {
        const timeOffset = headerByte & 0x1f;
        let ts = (lastTimestamp & ~0x1f) | timeOffset;
        if (ts < lastTimestamp) ts += 32; // 5-bit rollover
        lastTimestamp = ts;
      }
      const rec = { fields: new Map(), timestamp: lastTimestamp };
      for (const f of def.fields) {
        if (f.num === TIMESTAMP_FIELD) continue; // encoded in the header offset, not repeated in the data bytes
        const { value, size } = readField(view, offset, f.size, f.baseType, def.littleEndian);
        offset += size;
        if (value != null) rec.fields.set(f.num, value);
      }
      if (def.globalMesgNum === RECORD_MESG_NUM) records.push(rec);
      continue;
    }

    const isDefinition = (headerByte & 0x40) !== 0;
    const localType = headerByte & 0x0f;

    if (isDefinition) {
      const hasDevFields = (headerByte & 0x20) !== 0;
      offset += 1; // reserved
      const littleEndian = view.getUint8(offset) === 0; offset += 1;
      const globalMesgNum = view.getUint16(offset, littleEndian); offset += 2;
      const numFields = view.getUint8(offset); offset += 1;
      const fields = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({ num: view.getUint8(offset), size: view.getUint8(offset + 1), baseType: view.getUint8(offset + 2) });
        offset += 3;
      }
      if (hasDevFields) {
        const numDev = view.getUint8(offset); offset += 1;
        offset += numDev * 3; // developer fields aren't needed for depth/time — skip their bytes only
      }
      localDefs.set(localType, { globalMesgNum, littleEndian, fields });
      continue;
    }

    const def = localDefs.get(localType);
    if (!def) break; // referenced a definition we never saw — malformed/unsupported stream
    const rec = { fields: new Map(), timestamp: null };
    for (const f of def.fields) {
      const { value, size } = readField(view, offset, f.size, f.baseType, def.littleEndian);
      offset += size;
      if (f.num === TIMESTAMP_FIELD && typeof value === 'number') { rec.timestamp = value; lastTimestamp = value; }
      else if (value != null) rec.fields.set(f.num, value);
    }
    if (rec.timestamp == null) rec.timestamp = lastTimestamp;
    if (def.globalMesgNum === RECORD_MESG_NUM) records.push(rec);
  }
  return records;
}

/**
 * Pick whichever field+scale traces a plausible surface→depth→surface curve,
 * or null if none does. Several (field, scale) pairs can all look "physically
 * possible" at once — e.g. this same data read one scale coarser turns a
 * 20 m dive into an implausible-but-not-impossible 200 m one — so instead of
 * just maximizing depth, this scores candidates by how typical the resulting
 * max depth is of a real dive (peaking around 20 m, tapering off in both
 * directions in log-space) rather than rewarding whichever reads deepest.
 */
function findDepthField(records) {
  const candidates = new Set();
  for (const r of records) for (const k of r.fields.keys()) candidates.add(k);

  let best = null;
  for (const fieldNum of candidates) {
    const raw = records.map(r => r.fields.get(fieldNum)).filter(v => typeof v === 'number');
    if (raw.length < Math.max(10, records.length * 0.5)) continue;
    for (const scale of [1, 10, 100, 1000]) {
      const depths = raw.map(v => v / scale);
      const max = Math.max(...depths);
      if (max < 1.5 || max > 300) continue; // not a plausible dive depth range
      const edge = Math.max(1, Math.floor(depths.length * 0.05));
      const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
      const avgStart = avg(depths.slice(0, edge));
      const avgEnd = avg(depths.slice(-edge));
      if (avgStart > 5 || avgEnd > 5) continue; // a real dive starts and ends near the surface
      const typicalness = -Math.abs(Math.log2(max / 20)); // 0 at 20 m, falls off toward either extreme
      const score = typicalness - avgStart - avgEnd;
      if (!best || score > best.score) best = { fieldNum, scale, score };
    }
  }
  return best;
}

/**
 * Parse a Garmin FIT dive file.
 * @param {ArrayBuffer} buffer
 * @returns {{ dives: ImportedDive[], errors: string[] }} — same shape as parseUDDF.
 */
export function parseFIT(buffer) {
  let view;
  try { view = new DataView(buffer); } catch { return { dives: [], errors: ['Could not read this file.'] }; }
  if (view.byteLength < 14) return { dives: [], errors: ['File is too small to be a FIT file.'] };

  let header;
  try { header = readHeader(view); } catch (e) { return { dives: [], errors: [e.message] }; }

  let records;
  try { records = readRecordMessages(view, header); } catch {
    return { dives: [], errors: ['This FIT file could not be parsed — it may be corrupted or use an unsupported layout.'] };
  }
  if (!records.length) return { dives: [], errors: ['No dive-record data found in this FIT file.'] };

  const depthField = findDepthField(records);
  if (!depthField) {
    return {
      dives: [], errors: [
        'This FIT file doesn’t appear to contain recognizable dive-depth data ' +
        '(no field traced a plausible surface-to-depth-to-surface profile). ' +
        'Try exporting as UDDF or CSV from Garmin Connect instead.',
      ],
    };
  }

  const withTime = records.filter(r => typeof r.timestamp === 'number' && r.fields.has(depthField.fieldNum));
  const firstTs = withTime[0]?.timestamp;
  const samples = [];
  for (const r of withTime) {
    const t = +((r.timestamp - firstTs) / 60).toFixed(3);
    if (samples.length && t <= samples[samples.length - 1].t) continue; // drop non-advancing timestamps
    samples.push({ t, depth: +Math.max(0, r.fields.get(depthField.fieldNum) / depthField.scale).toFixed(1), gasIdx: 0 });
  }
  if (samples.length < 2) return { dives: [], errors: ['Not enough usable samples in this FIT file.'] };

  const air = makeGas(0.21, 0);
  return {
    dives: [{
      id: null,
      datetime: typeof firstTs === 'number' ? new Date(FIT_EPOCH_MS + firstTs * 1000).toISOString() : null,
      site: '',
      gps: null,
      buddy: '',
      notes: '',
      maxDepth: Math.max(...samples.map(s => s.depth)),
      duration: samples[samples.length - 1].t,
      surfaceIntervalMin: null,
      gases: [{ o2: air.o2, he: air.he, name: air.name }],
      samples,
    }],
    errors: [],
  };
}
