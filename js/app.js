/*
 * app.js — Abyss dive planner UI: routing, planner, logbook, settings, PWA.
 */

import { Tissues, makeGas, gasName, mod, planDive, replayProfile, surfaceInterval, SURFACE_PRESSURE } from './deco.js';
import { parseUDDF, exportUDDF } from './uddf.js';
import * as store from './store.js';
import * as cloud from './sync.js';
import { renderProfileChart, renderTissueChart, renderGFMeter, EVENT_STYLE } from './charts.js';

let settings = store.loadSettings();
let logbook = store.loadLogbook();
let lastPlan = null;
let lastPlanInputs = null;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const escapeHtml = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* ------------------------------ helpers ------------------------------ */

function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast toast-${kind}`;
  t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => { t.hidden = true; }, 4200);
}

function fmtDur(min) {
  if (min == null) return '—';
  const m = Math.round(min);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function fmtDate(iso) {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function gasesLabel(gases) {
  return (gases || []).map(g => g.name || gasName(g.o2, g.he)).join(' · ') || 'Air';
}

function diveGasObjects(dive) {
  return (dive.gases && dive.gases.length ? dive.gases : [{ o2: 0.21, he: 0 }])
    .map(g => makeGas(g.o2, g.he, g.name));
}

function diveEndTime(dive) {
  if (!dive.datetime) return null;
  return new Date(new Date(dive.datetime).getTime() + (dive.duration || 0) * 60000);
}

/* ----------------------- tissue chain (logbook) ----------------------- */

const FULL_DESAT_MIN = 48 * 60;

function recomputeChain() {
  let tissues = null;
  let lastEnd = null;
  for (const dive of logbook) {
    let start = tissues;
    let si = dive.surfaceIntervalMin;
    if (si == null && dive.datetime && lastEnd) {
      si = Math.max(0, (new Date(dive.datetime) - lastEnd) / 60000);
    }
    if (start) {
      if (si == null || si >= FULL_DESAT_MIN) start = null;
      else start = surfaceInterval(start, si, settings.surfacePressure);
    }
    const gases = diveGasObjects(dive);
    const samples = (dive.samples || []).map(s => ({ t: s.t, depth: s.depth, gas: gases[Math.min(s.gasIdx || 0, gases.length - 1)] }));
    const res = replayProfile(samples, start, settings.surfacePressure);
    dive.computed = {
      tissuesEnd: res.tissues.toJSON(),
      cns: res.cns, otu: res.otu, maxGF: res.maxGF,
      surfacingGF: res.tissues.surfacingGF(),
      repetitive: !!start,
    };
    tissues = res.tissues;
    lastEnd = diveEndTime(dive) || null;
  }
  store.saveLogbook(logbook);
}

/** Residual tissue state right now (or null if fully desaturated / empty book). */
function currentResidual() {
  const last = logbook[logbook.length - 1];
  if (!last || !last.computed) return null;
  const end = diveEndTime(last);
  const elapsedMin = end ? (Date.now() - end.getTime()) / 60000 : null;
  if (elapsedMin != null && (elapsedMin < 0 || elapsedMin >= FULL_DESAT_MIN)) return null;
  let tissues = Tissues.fromJSON(last.computed.tissuesEnd);
  tissues.surfaceP = settings.surfacePressure;
  if (elapsedMin != null && elapsedMin > 0) tissues = surfaceInterval(tissues, elapsedMin, settings.surfacePressure);
  if (tissues.surfacingGF() < 1) return null;
  return { tissues, sinceMin: elapsedMin, dive: last };
}

/* ------------------------------- routing ------------------------------ */

const routes = ['dashboard', 'planner', 'logbook', 'settings'];

function route() {
  const hash = location.hash.replace(/^#\//, '') || 'dashboard';
  const name = routes.includes(hash) ? hash : 'dashboard';
  for (const r of routes) {
    $(`#view-${r}`).classList.toggle('active', r === name);
  }
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  if (name === 'dashboard') renderDashboard();
  if (name === 'logbook') renderLogbook();
  if (name === 'planner') refreshResidualHint();
  window.scrollTo(0, 0);
}

/* ------------------------------ dashboard ----------------------------- */

function renderDashboard() {
  const tiles = $('#dash-tiles');
  const nDives = logbook.length;
  const last = logbook[nDives - 1];
  const deepest = nDives ? Math.max(...logbook.map(d => d.maxDepth || 0)) : 0;
  const totalMin = logbook.reduce((s, d) => s + (d.duration || 0), 0);

  tiles.innerHTML = `
    <div class="tile"><span class="tile-value">${nDives}</span><span class="tile-label">dives logged</span></div>
    <div class="tile"><span class="tile-value">${deepest ? deepest.toFixed(0) + ' m' : '—'}</span><span class="tile-label">deepest dive</span></div>
    <div class="tile"><span class="tile-value">${totalMin ? fmtDur(totalMin) : '—'}</span><span class="tile-label">time underwater</span></div>
    <div class="tile"><span class="tile-value">${last ? fmtDate(last.datetime).split(' · ')[0] : '—'}</span><span class="tile-label">last dive</span></div>`;

  const residual = currentResidual();
  const hint = $('#dash-tissue-hint');
  const meter = $('#dash-gf-meter');
  const chartBox = $('#dash-tissue-chart');
  if (residual) {
    hint.textContent = residual.sinceMin != null
      ? `Based on your last dive, ${fmtDur(residual.sinceMin)} ago. Compartments still off-gassing.`
      : 'Based on your last logged dive (no timestamp — interval unknown).';
    renderGFMeter(meter, residual.tissues.surfacingGF());
    renderTissueChart(chartBox, residual.tissues);
  } else {
    hint.textContent = nDives
      ? 'Fully desaturated — all compartments back at air equilibrium.'
      : 'No dives yet. Import a UDDF logbook or plan your first dive.';
    meter.innerHTML = '';
    renderTissueChart(chartBox, new Tissues(settings.surfacePressure));
  }

  const recent = $('#dash-recent');
  if (!nDives) {
    recent.innerHTML = '<p class="empty">Your logbook is empty.<br>Start fresh in the planner, or import UDDF files from your dive computer.</p>';
  } else {
    recent.innerHTML = logbook.slice(-5).reverse().map(diveCardHtml).join('');
    bindDiveCards(recent);
  }
}

/* ------------------------------ planner ------------------------------- */

let segRows = [{ depth: 30, time: 25 }];
let gasRows = [{ o2: 21, he: 0, use: 'bottom', switchDepth: null }];

function renderSegRows() {
  const box = $('#plan-segments');
  box.innerHTML = segRows.map((s, i) => `
    <div class="row seg-row" data-i="${i}">
      <label>Depth (m) <input type="number" class="seg-depth" min="1" max="200" step="1" value="${s.depth}"></label>
      <label>Time (min) <input type="number" class="seg-time" min="1" max="600" step="1" value="${s.time}"></label>
      ${segRows.length > 1 ? '<button class="btn btn-icon row-del" title="Remove level">✕</button>' : '<span class="row-note">incl. descent</span>'}
    </div>`).join('');
  box.querySelectorAll('.seg-row').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.seg-depth').addEventListener('change', e => { segRows[i].depth = +e.target.value || 1; });
    row.querySelector('.seg-time').addEventListener('change', e => { segRows[i].time = +e.target.value || 1; });
    row.querySelector('.row-del')?.addEventListener('click', () => { segRows.splice(i, 1); renderSegRows(); });
  });
}

function renderGasRows() {
  const box = $('#plan-gases');
  box.innerHTML = gasRows.map((g, i) => {
    const gas = makeGas(g.o2 / 100, g.he / 100);
    const modBottom = mod(gas, settings.ppO2MaxBottom, settings.surfacePressure);
    const modDeco = mod(gas, settings.ppO2MaxDeco, settings.surfacePressure);
    return `
    <div class="row gas-row" data-i="${i}">
      <label>O₂ % <input type="number" class="gas-o2" min="5" max="100" step="1" value="${g.o2}"></label>
      <label>He % <input type="number" class="gas-he" min="0" max="90" step="1" value="${g.he}"></label>
      <label>Role <select class="gas-use">
        <option value="bottom" ${g.use === 'bottom' ? 'selected' : ''}>Bottom</option>
        <option value="deco" ${g.use === 'deco' ? 'selected' : ''}>Deco</option>
      </select></label>
      <label class="gas-switch-wrap" ${g.use === 'deco' ? '' : 'hidden'}>Switch (m)
        <input type="number" class="gas-switch" min="3" max="60" step="3" value="${g.switchDepth ?? Math.max(3, Math.floor(modDeco / 3) * 3)}">
      </label>
      <span class="row-note">${gas.name} · MOD ${(g.use === 'deco' ? modDeco : modBottom).toFixed(0)} m</span>
      ${gasRows.length > 1 ? '<button class="btn btn-icon row-del" title="Remove gas">✕</button>' : ''}
    </div>`;
  }).join('');

  box.querySelectorAll('.gas-row').forEach(row => {
    const i = +row.dataset.i;
    const sync = () => {
      gasRows[i].o2 = +row.querySelector('.gas-o2').value || 21;
      gasRows[i].he = +row.querySelector('.gas-he').value || 0;
      gasRows[i].use = row.querySelector('.gas-use').value;
      const sw = row.querySelector('.gas-switch');
      gasRows[i].switchDepth = gasRows[i].use === 'deco' ? (+sw.value || 21) : null;
      renderGasRows();
    };
    row.querySelectorAll('input,select').forEach(inp => inp.addEventListener('change', sync));
    row.querySelector('.row-del')?.addEventListener('click', () => { gasRows.splice(i, 1); renderGasRows(); });
  });
}

function refreshResidualHint() {
  const residual = currentResidual();
  const hint = $('#plan-residual-hint');
  const check = $('#plan-use-residual');
  if (residual) {
    check.disabled = false;
    hint.textContent = `Last dive ${residual.sinceMin != null ? fmtDur(residual.sinceMin) + ' ago' : 'has no timestamp'} — surfacing gradient now ${residual.tissues.surfacingGF().toFixed(0)} %.`;
    if (residual.sinceMin != null) $('#plan-si').value = Math.round(residual.sinceMin);
  } else {
    check.checked = false;
    check.disabled = true;
    $('#plan-si-wrap').hidden = true;
    hint.textContent = logbook.length ? 'Tissues fully desaturated — no residual loading to carry.' : 'Log or import dives to enable repetitive-dive planning.';
  }
}

function runPlan() {
  try {
    const gfLow = (+$('#plan-gf-low').value || 35) / 100;
    const gfHigh = (+$('#plan-gf-high').value || 75) / 100;

    const bottom = gasRows.filter(g => g.use === 'bottom');
    const deco = gasRows.filter(g => g.use === 'deco').sort((a, b) => (b.switchDepth ?? 0) - (a.switchDepth ?? 0));
    if (!bottom.length) { toast('Add at least one bottom gas.', 'warn'); return; }
    const gases = [...bottom, ...deco].map(g => ({
      ...makeGas(g.o2 / 100, g.he / 100),
      use: g.use,
      switchDepth: g.use === 'deco' ? g.switchDepth : null,
    }));

    let startTissues = null;
    let siUsed = null;
    if ($('#plan-use-residual').checked) {
      const last = logbook[logbook.length - 1];
      if (last?.computed) {
        const si = Math.max(0, +$('#plan-si').value || 0);
        siUsed = si;
        let t = Tissues.fromJSON(last.computed.tissuesEnd);
        t.surfaceP = settings.surfacePressure;
        startTissues = si > 0 ? surfaceInterval(t, si, settings.surfacePressure) : t;
      }
    }

    const segments = segRows.map(s => ({ depth: +s.depth, time: +s.time }));
    const plan = planDive({
      segments, gases, gfLow, gfHigh,
      surfaceP: settings.surfacePressure,
      descentRate: settings.descentRate,
      ascentRate: settings.ascentRate,
      lastStopDepth: settings.lastStopDepth,
      sacBottom: settings.sacBottom,
      sacDeco: settings.sacDeco,
      ppO2MaxBottom: settings.ppO2MaxBottom,
      ppO2MaxDeco: settings.ppO2MaxDeco,
      startTissues,
    });
    lastPlan = plan;
    lastPlanInputs = { segments, gases, gfLow, gfHigh, siUsed, residual: !!startTissues };
    renderPlanResults(plan, gases);
  } catch (e) {
    console.error(e);
    toast(`Planning failed: ${e.message}`, 'error');
  }
}

function renderPlanResults(plan, gases) {
  $('#plan-results').hidden = false;

  const gfBadge = plan.surfacingGF;
  const firstActualStop = plan.schedule.find(s => s.type === 'stop')?.to ?? plan.firstStop;
  $('#plan-tiles').innerHTML = `
    <div class="tile"><span class="tile-value">${fmtDur(plan.runtime)}</span><span class="tile-label">total runtime</span></div>
    <div class="tile"><span class="tile-value">${plan.isDecoDive ? fmtDur(plan.tts) : '—'}</span><span class="tile-label">deco time (TTS)</span></div>
    <div class="tile"><span class="tile-value">${plan.isDecoDive ? firstActualStop + ' m' : 'no stop'}</span><span class="tile-label">first stop</span></div>
    <div class="tile"><span class="tile-value">${plan.ndl ? fmtDur(plan.ndl) : '0 min'}</span><span class="tile-label">NDL at bottom</span></div>
    <div class="tile"><span class="tile-value">${gfBadge.toFixed(0)} %</span><span class="tile-label">surfacing GF</span></div>
    <div class="tile"><span class="tile-value">${plan.cns.toFixed(0)} %</span><span class="tile-label">CNS clock</span></div>
    <div class="tile"><span class="tile-value">${plan.otu.toFixed(0)}</span><span class="tile-label">OTU</span></div>`;

  const wbox = $('#plan-warnings');
  wbox.innerHTML = plan.warnings.map(w => `
    <div class="alert alert-${w.level}">
      <span class="alert-icon">${w.level === 'critical' ? '⛔' : '⚠️'}</span>
      <span><strong>${w.level === 'critical' ? 'Critical' : 'Warning'}:</strong> ${escapeHtml(w.text)}</span>
    </div>`).join('');

  const events = plan.schedule.filter(s => s.type === 'switch')
    .map(s => ({ t: s.runtime, depth: s.from, type: 'gas-switch', label: s.gas.name }));
  renderProfileChart($('#plan-chart'), plan.profile, { events });

  const icons = { descent: '↓', 'level-change': '↳', bottom: '■', ascent: '↑', stop: '◦', switch: '⇄' };
  const rows = plan.schedule.map(s => `
    <tr class="sched-${s.type}">
      <td>${icons[s.type] || ''} ${s.type === 'switch' ? 'gas switch' : s.type.replace('-', ' ')}</td>
      <td>${s.type === 'descent' || s.type === 'ascent' || s.type === 'level-change'
        ? `${s.from.toFixed(0)} → ${s.to.toFixed(0)} m` : `${s.to.toFixed(0)} m`}</td>
      <td>${!s.duration ? '—' : s.duration < 0.95 ? `${Math.round(s.duration * 60)} s` : fmtDur(s.duration)}</td>
      <td>${Math.ceil(s.runtime)}</td>
      <td><span class="gas-chip">${escapeHtml(s.gas.name)}</span></td>
    </tr>`).join('');
  $('#plan-schedule').innerHTML = `
    <thead><tr><th>Phase</th><th>Depth</th><th>Duration</th><th>Runtime (min)</th><th>Gas</th></tr></thead>
    <tbody>${rows}</tbody>`;

  renderTissueChart($('#plan-tissue-chart'), plan.tissuesEnd);

  const gasRowsHtml = gases.map((g, i) => {
    const litres = plan.gasUsage[i];
    if (litres < 1) return '';
    return `<tr><td><span class="gas-chip">${escapeHtml(g.name)}</span></td>
      <td>${mod(g, g.use === 'deco' ? settings.ppO2MaxDeco : settings.ppO2MaxBottom, settings.surfacePressure).toFixed(0)} m</td>
      <td>${Math.ceil(litres / 10) * 10} L</td>
      <td>${Math.ceil(litres * 1.5 / 10) * 10} L</td></tr>`;
  }).join('');
  $('#plan-gas-table').innerHTML = `
    <thead><tr><th>Gas</th><th>MOD</th><th>Required</th><th>With ⅓ reserve ×1.5</th></tr></thead>
    <tbody>${gasRowsHtml}</tbody>`;

  $('#plan-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function savePlanToLogbook() {
  if (!lastPlan || !lastPlanInputs) return;
  const gases = lastPlanInputs.gases.map(g => ({ o2: g.o2, he: g.he, name: g.name }));
  const gasIdx = gas => {
    const i = lastPlanInputs.gases.indexOf(gas);
    return i >= 0 ? i : 0;
  };
  const samples = lastPlan.profile.map(p => ({ t: +p.t.toFixed(2), depth: +p.depth.toFixed(1), gasIdx: gasIdx(p.gas) }));
  const maxD = Math.max(...lastPlanInputs.segments.map(s => s.depth));
  const dive = {
    id: store.newId(),
    datetime: new Date().toISOString(),
    name: `Plan ${maxD} m / ${Math.round(lastPlanInputs.segments.reduce((s, x) => s + x.time, 0))} min`,
    site: '',
    notes: `Planned with GF ${Math.round(lastPlanInputs.gfLow * 100)}/${Math.round(lastPlanInputs.gfHigh * 100)}` +
      (lastPlanInputs.residual ? ` · repetitive (SI ${fmtDur(lastPlanInputs.siUsed)})` : ''),
    source: 'plan',
    events: lastPlan.schedule.filter(s => s.type === 'switch')
      .map(s => ({ t: +s.runtime.toFixed(2), type: 'gas-switch', label: s.gas.name })),
    maxDepth: Math.max(...samples.map(s => s.depth)),
    duration: lastPlan.runtime,
    surfaceIntervalMin: lastPlanInputs.residual ? lastPlanInputs.siUsed : null,
    gases,
    samples,
  };
  logbook = store.addDives([dive]);
  recomputeChain();
  scheduleSync();
  toast('Plan saved to logbook.', 'ok');
}

/* ------------------------------ logbook ------------------------------- */

function diveTitle(d) {
  return d.name || d.site || (d.source === 'plan' ? 'Planned dive' : 'Dive');
}

function diveCardHtml(d) {
  const gf = d.computed?.surfacingGF;
  const gfClass = gf == null ? '' : gf < 60 ? 'ok' : gf < 90 ? 'warn' : 'high';
  const planned = d.source === 'plan';
  const subtitle = [d.name && d.site ? d.site : '', d.gps ? '📍' : '', gasesLabel(d.gases)]
    .filter(Boolean).join(' · ');
  const nEvents = (d.events || []).length;
  return `
  <button class="dive-card${planned ? ' planned' : ''}" data-id="${escapeHtml(d.id)}">
    <div class="dive-card-main">
      <span class="dive-card-date">${fmtDate(d.datetime)}</span>
      <span class="dive-card-site">${escapeHtml(diveTitle(d))}</span>
      <span class="dive-card-gases">${escapeHtml(subtitle)}</span>
    </div>
    <div class="dive-card-stats">
      <span class="stat"><em>${(d.maxDepth ?? 0).toFixed(0)}</em> m</span>
      <span class="stat"><em>${Math.round(d.duration ?? 0)}</em> min</span>
      ${gf != null ? `<span class="gf-chip gf-${gfClass}" title="Surfacing gradient factor">GF ${gf.toFixed(0)}%</span>` : ''}
      ${nEvents ? `<span class="src-chip evt" title="Logged events">${nEvents} event${nEvents > 1 ? 's' : ''}</span>` : ''}
      ${planned ? '<span class="plan-chip" title="Planned dive — not yet dived">◈ PLANNED</span>' : ''}
      ${d.computed?.repetitive ? '<span class="src-chip rep">repetitive</span>' : ''}
    </div>
  </button>`;
}

/** Depth at minute t, linearly interpolated from samples. */
function depthAt(samples, t) {
  if (!samples?.length) return 0;
  let prev = samples[0];
  for (const s of samples) {
    if (s.t >= t) {
      if (s.t === prev.t) return s.depth;
      const f = (t - prev.t) / (s.t - prev.t);
      return prev.depth + (s.depth - prev.depth) * Math.max(0, Math.min(1, f));
    }
    prev = s;
  }
  return prev.depth;
}

/** Stored events if any; otherwise derive gas switches from the samples. */
function diveEvents(dive, samples) {
  if (dive.events?.length) return dive.events;
  const evs = [];
  let lastGi = samples.length ? samples[0].gas : null;
  for (const s of samples) {
    if (s.gas !== lastGi) { evs.push({ t: s.t, type: 'gas-switch', label: s.gas.name }); lastGi = s.gas; }
  }
  return evs;
}

function bindDiveCards(root) {
  root.querySelectorAll('.dive-card').forEach(c =>
    c.addEventListener('click', () => showDiveDetail(c.dataset.id)));
}

function renderLogbook() {
  $('#logbook-detail').hidden = true;
  const list = $('#logbook-list');
  list.hidden = false;
  if (!logbook.length) {
    list.innerHTML = '<p class="empty">No dives yet. Import UDDF files or save a plan from the planner.</p>';
    return;
  }
  list.innerHTML = [...logbook].reverse().map(diveCardHtml).join('');
  bindDiveCards(list);
}

function showDiveDetail(id) {
  const dive = logbook.find(d => d.id === id);
  if (!dive) return;
  $('#logbook-list').hidden = true;
  const box = $('#logbook-detail');
  box.hidden = false;

  const c = dive.computed || {};
  const planned = dive.source === 'plan';
  const mapLink = dive.gps
    ? `<a class="map-link" href="https://www.openstreetmap.org/?mlat=${dive.gps.lat}&mlon=${dive.gps.lon}#map=14/${dive.gps.lat}/${dive.gps.lon}" target="_blank" rel="noopener">📍 ${dive.gps.lat.toFixed(4)}, ${dive.gps.lon.toFixed(4)}</a>`
    : '';
  box.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="btn-back-log">← All dives</button>
    <div class="page-head">
      <h2 class="detail-title">${escapeHtml(diveTitle(dive))}
        ${planned ? '<span class="plan-chip">◈ PLANNED</span>' : ''}
        <span class="detail-date">${fmtDate(dive.datetime)}</span>
      </h2>
      <div class="page-actions">
        <button class="btn btn-outline btn-sm" id="btn-edit-dive">✎ Edit dive</button>
        <button class="btn btn-danger btn-sm" id="btn-del-dive">Delete dive</button>
      </div>
    </div>
    ${dive.site || mapLink ? `<p class="detail-meta">${escapeHtml(dive.site || '')} ${mapLink}</p>` : ''}

    <form class="card edit-form" id="dive-edit" hidden>
      <h2>Edit dive</h2>
      <div class="field-grid">
        <label>Name <input id="ed-name" value="${escapeHtml(dive.name || '')}" placeholder="e.g. Morning wall dive"></label>
        <label>Dive site <input id="ed-site" value="${escapeHtml(dive.site || '')}" placeholder="e.g. Blue Hole, Gozo"></label>
        <label>Latitude <input id="ed-lat" type="number" step="any" min="-90" max="90" value="${dive.gps ? dive.gps.lat : ''}"></label>
        <label>Longitude <input id="ed-lon" type="number" step="any" min="-180" max="180" value="${dive.gps ? dive.gps.lon : ''}"></label>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-use-gps">📍 Use current location</button>
      <label class="mt">Notes <textarea id="ed-notes" rows="3" placeholder="Conditions, buddy, equipment, anything worth remembering…">${escapeHtml(dive.notes || '')}</textarea></label>
      <div class="account-actions">
        <button type="submit" class="btn btn-primary btn-sm">Save changes</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-edit-cancel">Cancel</button>
      </div>
    </form>
    <div class="tile-row">
      <div class="tile"><span class="tile-value">${(dive.maxDepth ?? 0).toFixed(1)} m</span><span class="tile-label">max depth</span></div>
      <div class="tile"><span class="tile-value">${fmtDur(dive.duration)}</span><span class="tile-label">duration</span></div>
      <div class="tile"><span class="tile-value">${c.surfacingGF != null ? c.surfacingGF.toFixed(0) + ' %' : '—'}</span><span class="tile-label">surfacing GF</span></div>
      <div class="tile"><span class="tile-value">${c.maxGF != null ? c.maxGF.toFixed(0) + ' %' : '—'}</span><span class="tile-label">max GF in dive</span></div>
      <div class="tile"><span class="tile-value">${c.cns != null ? c.cns.toFixed(0) + ' %' : '—'}</span><span class="tile-label">CNS</span></div>
      <div class="tile"><span class="tile-value">${c.otu != null ? c.otu.toFixed(0) : '—'}</span><span class="tile-label">OTU</span></div>
    </div>
    ${dive.surfaceIntervalMin != null ? `<p class="card-hint">Surface interval before dive: ${fmtDur(dive.surfaceIntervalMin)}${c.repetitive ? ' — residual loading carried into this dive.' : ''}</p>` : ''}
    ${dive.notes ? `<p class="card-hint">${escapeHtml(dive.notes)}</p>` : ''}
    <div class="card">
      <h2>Profile</h2>
      <p class="card-hint">Gases: ${escapeHtml(gasesLabel(dive.gases))}</p>
      <div id="detail-chart" class="chart-box"></div>
    </div>
    <div class="card">
      <h2>Events</h2>
      <div id="event-list"></div>
      <div class="row event-add">
        <label>Time (min) <input id="ev-time" type="number" min="0" step="0.5" max="${Math.ceil(dive.duration || 999)}"></label>
        <label>Type <select id="ev-type">
          ${Object.entries(EVENT_STYLE).map(([k, v]) => `<option value="${k}">${v.glyph} ${v.name}</option>`).join('')}
        </select></label>
        <label>Label <input id="ev-label" placeholder="optional — e.g. free-flow on stage reg"></label>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-add-event">+ Add</button>
      </div>
    </div>
    <div class="card">
      <h2>Tissue loading at end of dive</h2>
      <div id="detail-tissues" class="chart-box"></div>
    </div>`;

  $('#btn-back-log').addEventListener('click', renderLogbook);
  $('#btn-del-dive').addEventListener('click', () => {
    if (!confirm('Delete this dive? Tissue chains for later dives will be recomputed.')) return;
    logbook = store.deleteDive(dive.id);
    recomputeChain();
    scheduleSync();
    renderLogbook();
    toast('Dive deleted.', 'ok');
  });

  // --- edit form ---
  const editForm = $('#dive-edit');
  $('#btn-edit-dive').addEventListener('click', () => { editForm.hidden = !editForm.hidden; });
  $('#btn-edit-cancel').addEventListener('click', () => { editForm.hidden = true; });
  $('#btn-use-gps').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Geolocation is not available in this browser.', 'warn'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        $('#ed-lat').value = pos.coords.latitude.toFixed(6);
        $('#ed-lon').value = pos.coords.longitude.toFixed(6);
      },
      () => toast('Could not get your position.', 'warn'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
  editForm.addEventListener('submit', ev => {
    ev.preventDefault();
    const lat = parseFloat($('#ed-lat').value);
    const lon = parseFloat($('#ed-lon').value);
    const gps = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    logbook = store.updateDive(dive.id, {
      name: $('#ed-name').value.trim(),
      site: $('#ed-site').value.trim(),
      gps,
      notes: $('#ed-notes').value.trim(),
    });
    scheduleSync();
    toast('Dive updated.', 'ok');
    showDiveDetail(dive.id);
  });

  // --- profile + tissues ---
  const gases = diveGasObjects(dive);
  const samples = (dive.samples || []).map(s => ({ t: s.t, depth: s.depth, gas: gases[Math.min(s.gasIdx || 0, gases.length - 1)] }));
  // rebuild starting tissues for a faithful ceiling overlay
  const idx = logbook.indexOf(dive);
  let start = null;
  if (idx > 0 && dive.computed?.repetitive) {
    const prev = logbook[idx - 1];
    if (prev.computed) {
      let t = Tissues.fromJSON(prev.computed.tissuesEnd);
      const si = dive.surfaceIntervalMin ?? 0;
      start = surfaceInterval(t, si, settings.surfacePressure);
    }
  }
  const res = replayProfile(samples, start, settings.surfacePressure);

  const events = diveEvents(dive, samples)
    .map(e => ({ ...e, depth: e.depth ?? depthAt(samples, e.t) }))
    .sort((a, b) => a.t - b.t);
  renderProfileChart($('#detail-chart'), res.profile, { events });
  renderTissueChart($('#detail-tissues'), res.tissues);

  // --- events list ---
  function renderEventList() {
    const list = $('#event-list');
    const evs = diveEvents(dive, samples).slice().sort((a, b) => a.t - b.t);
    if (!evs.length) {
      list.innerHTML = '<p class="card-hint">No events yet — add gas switches, emergencies, sightings or notes at a point in the dive.</p>';
      return;
    }
    const stored = !!dive.events?.length;
    list.innerHTML = evs.map((e, i) => {
      const st = EVENT_STYLE[e.type] || EVENT_STYLE.note;
      return `<div class="event-row">
        <span class="event-dot" style="background:${st.color}">${st.glyph}</span>
        <span class="event-time">${e.t.toFixed(1).replace(/\.0$/, '')} min</span>
        <span class="event-text">${st.name}${e.label ? ` — ${escapeHtml(e.label)}` : ''}</span>
        ${stored ? `<button class="btn btn-icon event-del" data-i="${i}" title="Remove event">✕</button>` : '<span class="row-note">auto</span>'}
      </div>`;
    }).join('');
    list.querySelectorAll('.event-del').forEach(btn => btn.addEventListener('click', () => {
      const evsSorted = dive.events.slice().sort((a, b) => a.t - b.t);
      evsSorted.splice(+btn.dataset.i, 1);
      logbook = store.updateDive(dive.id, { events: evsSorted });
      scheduleSync();
      showDiveDetail(dive.id);
    }));
  }
  renderEventList();

  $('#btn-add-event').addEventListener('click', () => {
    const t = parseFloat($('#ev-time').value);
    if (!Number.isFinite(t) || t < 0 || t > (dive.duration || 0) + 1) {
      toast('Enter a time within the dive (minutes).', 'warn');
      return;
    }
    // materialise auto-derived events on first manual add so nothing is lost
    const base = diveEvents(dive, samples).map(({ t, type, label }) => ({ t, type, label }));
    base.push({ t, type: $('#ev-type').value, label: $('#ev-label').value.trim() });
    logbook = store.updateDive(dive.id, { events: base.sort((a, b) => a.t - b.t) });
    scheduleSync();
    toast('Event added.', 'ok');
    showDiveDetail(dive.id);
  });
}

/* --------------------------- import / export --------------------------- */

function importFiles(files) {
  if (!files.length) return;
  let imported = 0;
  const allErrors = [];
  let pending = files.length;

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const { dives, errors } = parseUDDF(reader.result);
      allErrors.push(...errors);
      if (dives.length) {
        const entries = dives.map(d => ({
          id: store.newId(),
          datetime: d.datetime,
          site: d.site || file.name.replace(/\.(uddf|xml)$/i, ''),
          gps: d.gps || null,
          notes: d.notes,
          source: 'uddf',
          maxDepth: d.maxDepth,
          duration: d.duration,
          surfaceIntervalMin: d.surfaceIntervalMin,
          gases: d.gases.map(g => ({ o2: g.o2, he: g.he, name: g.name })),
          samples: d.samples,
        }));
        logbook = store.addDives(entries);
        imported += entries.length;
      }
      if (--pending === 0) {
        recomputeChain();
        scheduleSync();
        if (imported) {
          toast(`Imported ${imported} dive${imported > 1 ? 's' : ''}. Tissue chains computed.`, 'ok');
          location.hash = '#/logbook';
          renderLogbook();
          renderDashboard();
        }
        if (allErrors.length) toast(allErrors[0], 'warn');
      }
    };
    reader.onerror = () => { allErrors.push(`Could not read ${file.name}`); if (--pending === 0 && allErrors.length) toast(allErrors[0], 'error'); };
    reader.readAsText(file);
  }
}

function exportLogbook() {
  if (!logbook.length) { toast('Logbook is empty — nothing to export.', 'warn'); return; }
  const xml = exportUDDF(logbook);
  const blob = new Blob([xml], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `abyss-logbook-${new Date().toISOString().slice(0, 10)}.uddf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Logbook exported as UDDF.', 'ok');
}

/* ------------------------------ settings ------------------------------ */

const SETTING_FIELDS = ['gfLow', 'gfHigh', 'lastStopDepth', 'surfacePressure', 'descentRate', 'ascentRate', 'sacBottom', 'sacDeco', 'ppO2MaxBottom', 'ppO2MaxDeco'];

function renderSettings() {
  for (const f of SETTING_FIELDS) {
    const input = $(`#set-${f}`);
    if (input) input.value = settings[f];
  }
}

function saveSettingsFromForm() {
  for (const f of SETTING_FIELDS) {
    const input = $(`#set-${f}`);
    if (input) {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) settings[f] = v;
    }
  }
  store.saveSettings(settings);
  store.touchSettings();
  recomputeChain();
  scheduleSync();
  toast('Settings saved.', 'ok');
}

/* --------------------------- cloud account ---------------------------- */

let lastSyncAt = null;
let syncTimer = null;

function refreshAccountUI() {
  const acc = cloud.getAccount();
  $('#btn-account').textContent = acc ? acc.email.split('@')[0] : 'Sign in';
  $('#btn-account').classList.toggle('signed-in', !!acc);
  $('#account-signed-out').hidden = !!acc;
  $('#account-signed-in').hidden = !acc;
  if (acc) {
    $('#acc-current-email').textContent = acc.email;
    $('#acc-sync-info').textContent = lastSyncAt
      ? `Last synced ${lastSyncAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. Changes sync up automatically; offline changes sync when you reconnect.`
      : 'Not synced yet in this session.';
  }
  $('#set-account-status').textContent = acc
    ? `Signed in as ${acc.email} — logbook syncs to the cloud${lastSyncAt ? `, last synced ${lastSyncAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}.`
    : 'Not signed in — the logbook lives only on this device.';
  $('#btn-sync-now').hidden = !acc;
}

/** Debounced upward sync after local mutations. Fails soft when offline. */
function scheduleSync() {
  if (!cloud.getAccount()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync({ silent: true }), 1500);
}

async function doSync({ silent = false } = {}) {
  const acc = cloud.getAccount();
  if (!acc) return;
  try {
    const result = await cloud.syncLogbook(logbook, store.loadTombstones(), settings, store.settingsUpdatedAt());
    lastSyncAt = new Date();
    if (result.settingsChanged) {
      // a newer settings edit from another device wins
      settings = { ...store.DEFAULT_SETTINGS, ...result.settings };
      store.saveSettings(settings);
      store.setSettingsTimestamp(result.settingsAt);
      renderSettings();
      $('#plan-gf-low').value = settings.gfLow;
      $('#plan-gf-high').value = settings.gfHigh;
    }
    if (result.changed || result.settingsChanged) {
      if (result.changed) logbook = result.dives;
      store.saveLogbook(logbook);
      recomputeChain();
      route(); // re-render current view with merged data
      if (!silent) toast(result.changed ? 'Logbook merged from the cloud.' : 'Settings updated from the cloud.', 'ok');
    } else if (!silent) {
      toast('Logbook synced.', 'ok');
    }
  } catch (e) {
    if (e.kind === 'expired') {
      cloud.dropAccount();
      refreshAccountUI();
      toast(e.message, 'warn');
    } else if (!silent && e.kind === 'offline') {
      toast(e.message, 'warn');
    } else if (!silent) {
      toast(`Sync failed: ${e.message}`, 'error');
    }
    // offline in silent mode: ignore — the 'online' listener will retry
  }
  refreshAccountUI();
}

function initAccount() {
  const dialog = $('#account-dialog');
  const errBox = $('#account-error');
  const showErr = msg => { errBox.textContent = msg; errBox.hidden = false; };

  const openDialog = () => { errBox.hidden = true; refreshAccountUI(); dialog.showModal(); };
  $('#btn-account').addEventListener('click', openDialog);
  $('#btn-account-settings').addEventListener('click', openDialog);
  $('#btn-sync-now').addEventListener('click', () => doSync());

  const credentials = () => ({
    email: $('#acc-email').value.trim(),
    password: $('#acc-password').value,
  });

  async function doAuth(fn, label) {
    const { email, password } = credentials();
    if (!email || password.length < 8) { showErr('Enter your email and a password of at least 8 characters.'); return; }
    try {
      await fn(email, password);
      $('#acc-password').value = '';
      errBox.hidden = true;
      toast(`${label} as ${email}. Syncing logbook…`, 'ok');
      await doSync({ silent: true });
      refreshAccountUI();
    } catch (e) {
      showErr(e.message);
    }
  }

  $('#btn-do-login').addEventListener('click', () => doAuth(cloud.login, 'Signed in'));
  $('#btn-do-register').addEventListener('click', () => doAuth(cloud.register, 'Account created'));
  $('#btn-do-logout').addEventListener('click', async () => {
    await cloud.logout();
    lastSyncAt = null;
    refreshAccountUI();
    toast('Signed out. The logbook stays on this device.', 'ok');
  });
  $('#btn-do-sync').addEventListener('click', () => doSync());

  // reconnects push local changes up automatically
  window.addEventListener('online', () => doSync({ silent: true }));

  refreshAccountUI();
  if (cloud.getAccount() && navigator.onLine) doSync({ silent: true });
}

/* -------------------------------- PWA --------------------------------- */

let deferredInstall = null;

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed', e));
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    $('#btn-install').hidden = false;
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('#btn-install').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; toast('Abyss installed — it now works offline.', 'ok'); });
}

/* ------------------------------- init --------------------------------- */

function init() {
  // planner defaults from settings
  $('#plan-gf-low').value = settings.gfLow;
  $('#plan-gf-high').value = settings.gfHigh;
  renderSegRows();
  renderGasRows();
  renderSettings();
  recomputeChain();

  $('#btn-add-segment').addEventListener('click', () => {
    const last = segRows[segRows.length - 1];
    segRows.push({ depth: Math.max(3, last.depth - 9), time: 10 });
    renderSegRows();
  });
  $('#btn-add-gas').addEventListener('click', () => {
    gasRows.push({ o2: 50, he: 0, use: 'deco', switchDepth: 21 });
    renderGasRows();
  });
  $('#btn-plan').addEventListener('click', runPlan);
  $('#btn-save-plan').addEventListener('click', savePlanToLogbook);
  $('#plan-use-residual').addEventListener('change', e => {
    $('#plan-si-wrap').hidden = !e.target.checked;
  });

  const fileInput = $('#file-uddf');
  fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = ''; });
  for (const id of ['#btn-import-hero', '#btn-import-log']) {
    $(id).addEventListener('click', () => fileInput.click());
  }
  $('#btn-export-log').addEventListener('click', exportLogbook);
  $('#btn-export-settings-log').addEventListener('click', exportLogbook);

  $('#btn-save-settings').addEventListener('click', saveSettingsFromForm);
  $('#btn-clear-data').addEventListener('click', () => {
    const signedIn = !!cloud.getAccount();
    const msg = signedIn
      ? 'Clear the entire logbook? This also removes it from your cloud account on the next sync. Export first if you want to keep it.'
      : 'Clear the entire logbook and all locally stored data? Export first if you want to keep it.';
    if (!confirm(msg)) return;
    store.clearAll();
    logbook = [];
    scheduleSync();
    renderLogbook();
    renderDashboard();
    toast('All data cleared.', 'ok');
  });

  window.addEventListener('hashchange', route);
  route();
  initAccount();
  initPWA();
}

init();
