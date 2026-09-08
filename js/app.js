/*
 * app.js — Abyss dive planner UI: routing, planner, logbook, settings, PWA.
 */

import { Tissues, makeGas, gasName, mod, minDepth, MIN_PPO2, planDive, replayProfile, surfaceInterval, depthToPressure, SURFACE_PRESSURE } from './deco.js';
import { parseUDDF, exportUDDF } from './uddf.js';
import { parseCSV } from './csv.js';
import { parseFIT } from './fit.js';
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

function toast(msg, kind = 'info', { sticky = false, onClick = null } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast toast-${kind}`;
  t.classList.toggle('toast-clickable', !!onClick);
  t.onclick = onClick;
  t.hidden = false;
  clearTimeout(toast._h);
  if (!sticky) toast._h = setTimeout(() => { t.hidden = true; }, 4200);
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

/**
 * Two-track chaining: real dives chain only off other real dives, so a planned
 * dive sitting in the book never distorts actual saturation. Planned dives
 * chain off everything before them (real + earlier plans) — the projection.
 */
function recomputeChain() {
  let lastReal = null; // { tissues, end } after the last real dive
  let lastAny = null;  // … after the last dive of any kind
  for (const dive of logbook) {
    const isPlan = dive.source === 'plan';
    const base = isPlan ? lastAny : lastReal;

    let start = base?.tissues || null;
    let si = dive.surfaceIntervalMin;
    if (si == null && dive.datetime && base?.end) {
      si = Math.max(0, (new Date(dive.datetime) - base.end) / 60000);
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
    const state = { tissues: res.tissues, end: diveEndTime(dive) || null };
    lastAny = state;
    if (!isPlan) lastReal = state;
  }
  store.saveLogbook(logbook);
}

/**
 * Residual tissue state right now — or, when the chain ends with planned
 * dives in the future, the projected state at the end of the last one.
 * mode 'real' considers only actual dives (current saturation);
 * mode 'all' includes planned dives (projected saturation).
 * Returns null if fully desaturated / empty book.
 */
function currentResidual(mode = 'all') {
  let last = null;
  for (let i = logbook.length - 1; i >= 0; i--) {
    if (mode === 'all' || logbook[i].source !== 'plan') { last = logbook[i]; break; }
  }
  if (!last || !last.computed) return null;
  const end = diveEndTime(last);
  let elapsedMin = end ? (Date.now() - end.getTime()) / 60000 : null;
  const future = elapsedMin != null && elapsedMin < 0;
  if (future) elapsedMin = 0; // last dive hasn't happened yet — state at its surfacing
  if (elapsedMin != null && elapsedMin >= FULL_DESAT_MIN) return null;
  let tissues = Tissues.fromJSON(last.computed.tissuesEnd);
  tissues.surfaceP = settings.surfacePressure;
  if (elapsedMin != null && elapsedMin > 0) tissues = surfaceInterval(tissues, elapsedMin, settings.surfacePressure);
  if (tissues.surfacingGF() < 1) return null;
  return { tissues, sinceMin: future ? null : elapsedMin, dive: last, future, end };
}

/** Surface rest (minutes, 30-min resolution) until tissues are fully desaturated. */
function desatMinutes(tissues) {
  let t = tissues.clone();
  let min = 0;
  while (min < FULL_DESAT_MIN && t.surfacingGF() >= 1) {
    t = surfaceInterval(t, 30, settings.surfacePressure);
    min += 30;
  }
  return min;
}

/* ------------------------------- routing ------------------------------ */

const routes = ['dashboard', 'planner', 'logbook', 'settings'];
const SHARE_ROUTE_RE = /^shared\/([a-f0-9]{32})$/;
let pendingLogbookDetailId = null;
let pendingSharedImport = null; // {dive, sharedBy} awaiting sign-in before it can be added

/**
 * Signed-out visitors only ever see the landing page — the tab bar itself is
 * hidden, and whatever hash is in the URL is ignored until they sign in — with
 * one exception: a #/shared/<id> link is a public page, reachable whether or
 * not the visitor has an account, so it's resolved before the auth gate below.
 * Signing in (or out) re-runs this and swaps the whole app in or out.
 */
function route() {
  const rawHash = location.hash.replace(/^#\//, '');
  const authed = !!cloud.getAccount();
  $('#main-nav').classList.toggle('nav-hidden', !authed);

  const sharedMatch = SHARE_ROUTE_RE.exec(rawHash);
  if (sharedMatch) {
    for (const r of routes) $(`#view-${r}`).classList.remove('active');
    $('#view-landing').classList.remove('active');
    $('#view-shared').classList.add('active');
    $$('.nav a').forEach(a => a.classList.remove('active'));
    window.scrollTo(0, 0);
    loadSharedPlan(sharedMatch[1]);
    return;
  }
  $('#view-shared').classList.remove('active');

  if (!authed) {
    for (const r of routes) $(`#view-${r}`).classList.remove('active');
    $$('.nav a').forEach(a => a.classList.remove('active'));
    $('#view-landing').classList.add('active');
    window.scrollTo(0, 0);
    return;
  }
  $('#view-landing').classList.remove('active');

  const name = routes.includes(rawHash) ? rawHash : 'dashboard';
  for (const r of routes) {
    $(`#view-${r}`).classList.toggle('active', r === name);
  }
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  window.scrollTo(0, 0);

  if (name === 'dashboard') renderDashboard();
  if (name === 'logbook') {
    if (pendingLogbookDetailId) {
      const id = pendingLogbookDetailId;
      pendingLogbookDetailId = null;
      showDiveDetail(id);
    } else {
      renderLogbook();
    }
  }
  if (name === 'planner') { refreshResidualHint(); refreshSafetyStopHint(); }
}

/** Navigate to (and reveal) a dive's detail view, switching to the logbook route first if needed. */
function goToDiveDetail(id) {
  if (location.hash === '#/logbook') {
    showDiveDetail(id);
  } else {
    pendingLogbookDetailId = id;
    location.hash = '#/logbook';
  }
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

  // --- current saturation: real dives only, off-gassing live ---
  const cur = currentResidual('real');
  const hint = $('#dash-tissue-hint');
  const meter = $('#dash-gf-meter');
  const chartBox = $('#dash-tissue-chart');
  const nReal = logbook.filter(d => d.source !== 'plan').length;
  if (cur) {
    const desat = desatMinutes(cur.tissues);
    hint.textContent = cur.sinceMin != null
      ? `Live — based on your last dive, ${fmtDur(cur.sinceMin)} ago. Fully desaturated in ≈ ${fmtDur(desat)}.`
      : 'Based on your last logged dive (no timestamp — interval unknown).';
    renderGFMeter(meter, cur.tissues.surfacingGF());
    renderTissueChart(chartBox, cur.tissues);
  } else {
    hint.textContent = nReal
      ? 'Fully desaturated — all compartments back at air equilibrium.'
      : 'No dives yet. Import a UDDF logbook or plan your first dive.';
    meter.innerHTML = '';
    renderTissueChart(chartBox, new Tissues(settings.surfacePressure));
  }

  // --- planned saturation: projection at the end of the planned chain ---
  const plannedBlock = $('#dash-planned-block');
  const upcoming = logbook.filter(d => d.source === 'plan' && (e => e && e > new Date())(diveEndTime(d)));
  const proj = upcoming.length ? currentResidual('all') : null;
  if (proj && proj.future) {
    plannedBlock.hidden = false;
    const desat = desatMinutes(proj.tissues);
    $('#dash-planned-hint').textContent =
      `After your ${upcoming.length} planned dive${upcoming.length > 1 ? 's' : ''}, ` +
      `ending ${fmtDate(proj.end.toISOString())}: you'll need ≈ ${fmtDur(desat)} of surface rest to fully desaturate.`;
    renderGFMeter($('#dash-planned-meter'), proj.tissues.surfacingGF());
  } else {
    plannedBlock.hidden = true;
  }

  const recent = $('#dash-recent');
  if (!nDives) {
    recent.innerHTML = '<p class="empty">Your logbook is empty.<br>Start fresh in the planner, or import a dive log (UDDF, CSV or Garmin FIT) from your dive computer.</p>';
  } else {
    recent.innerHTML = logbook.slice(-5).reverse().map(diveCardHtml).join('');
    bindDiveCards(recent);
  }
}

/* ------------------------------ planner ------------------------------- */

let segRows = [{ depth: 30, time: 25 }];
let gasRows = [{ o2: 21, he: 0, use: 'bottom', switchDepth: null, switchAuto: true }];

// 'travel' and 'bottom' share one descent-side chain (see deco.js); 'deco' is
// the ascent-side chain; 'bailout' is carried but never actually breathed.
const CHAIN_ROLES = ['travel', 'bottom'];

/**
 * Best switch depth for a gas row, rounded to a 3 m stop:
 *  - deco gases switch UP as deep as their ppO2 limit allows (more O2, sooner)
 *  - a non-primary travel/bottom gas (a leaner/hypoxic mix reached via a
 *    shallower travel gas) switches DOWN no shallower than the depth it
 *    stops being hypoxic
 * Returns 0 for a travel/bottom gas that was never hypoxic in the first place.
 */
function suggestSwitchDepth(role, gasObj) {
  if (role === 'deco') {
    const modDeco = mod(gasObj, settings.ppO2MaxDeco, settings.surfacePressure);
    return Math.max(3, Math.floor(modDeco / 3) * 3);
  }
  const floor = minDepth(gasObj, MIN_PPO2, settings.surfacePressure);
  return floor <= 0 ? 0 : Math.max(3, Math.ceil(floor / 3) * 3);
}

/**
 * Which travel/bottom row is breathed at the surface: whichever is safe the
 * shallowest (lowest ppO₂-floor depth), not just whichever was added first —
 * so adding a travel gas after an already-hypoxic bottom gas still works,
 * instead of requiring it to be reordered to the front.
 */
function primaryBottomRow(chainRows) {
  let best = chainRows[0], bestFloor = Infinity;
  for (const g of chainRows) {
    const floor = minDepth(makeGas(g.o2 / 100, g.he / 100), MIN_PPO2, settings.surfacePressure);
    if (floor < bestFloor) { best = g; bestFloor = floor; }
  }
  return best;
}

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

/** ppO2 (bar) a gas gives at a given depth, at the current surface pressure. */
function ppO2At(depth, gasObj) {
  return depthToPressure(depth, settings.surfacePressure) * gasObj.o2;
}

/**
 * Order gasRows the way they'll actually be breathed: the surface (primary)
 * travel/bottom gas, then its deeper chain members shallowest-switch-in
 * first, then deco gases deepest-switch first (the order you ascend through
 * them), then bailout last. Runs before every render so the list re-sorts
 * itself as roles/depths change instead of staying in add-order.
 */
function sortGasRows(primary) {
  const bucket = g => (g.use === 'bailout' ? 3 : g.use === 'deco' ? 2 : g === primary ? 0 : 1);
  gasRows.sort((a, b) => {
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 1) return (a.switchDepth ?? 0) - (b.switchDepth ?? 0);
    if (ba === 2) return (b.switchDepth ?? 0) - (a.switchDepth ?? 0);
    return 0;
  });
}

// renderGasRows() deliberately does NOT sort on every call — resorting after
// every keystroke would make a row jump out from under you between two edits
// of the same row (e.g. set O2 then He). Callers that represent a natural
// checkpoint (add/remove a gas, about to calculate) call sortGasRows() first.
function renderGasRows() {
  const box = $('#plan-gases');
  const primary = primaryBottomRow(gasRows.filter(g => CHAIN_ROLES.includes(g.use)));

  box.innerHTML = gasRows.map((g, i) => {
    const gas = makeGas(g.o2 / 100, g.he / 100);
    const modBottom = mod(gas, settings.ppO2MaxBottom, settings.surfacePressure);
    const modDeco = mod(gas, settings.ppO2MaxDeco, settings.surfacePressure);
    const isChain = CHAIN_ROLES.includes(g.use);
    const isPrimary = isChain && g === primary;
    const needsSwitch = g.use === 'deco' || (isChain && !isPrimary);
    if (needsSwitch && g.switchAuto !== false) g.switchDepth = suggestSwitchDepth(g.use, gas);

    const hypoxicAtSurface = isPrimary && settings.surfacePressure * gas.o2 < MIN_PPO2;
    const modText = (depth) => `MOD ${depth.toFixed(0)} m (ppO₂ ${ppO2At(depth, gas).toFixed(2)})`;
    const switchText = () => `switch ${(g.switchDepth ?? 0).toFixed(0)} m (ppO₂ ${ppO2At(g.switchDepth ?? 0, gas).toFixed(2)})`;
    const note = g.use === 'bailout'
      ? `${gas.name} · ${modText(modBottom)} · carried as bailout, not breathed in this plan`
      : g.use === 'deco'
        ? `${gas.name} · ${switchText()} · ${modText(modDeco)}`
        : isPrimary
          ? `${gas.name} · ${modText(modBottom)}`
          : `${gas.name} · ${switchText()} · ${modText(modBottom)}`;

    return `
    <div class="row gas-row" data-i="${i}">
      <label>O₂ % <input type="number" class="gas-o2" min="5" max="100" step="1" value="${g.o2}"></label>
      <label>He % <input type="number" class="gas-he" min="0" max="90" step="1" value="${g.he}"></label>
      <label>Role <select class="gas-use">
        <option value="travel" ${g.use === 'travel' ? 'selected' : ''}>Travel</option>
        <option value="bottom" ${g.use === 'bottom' ? 'selected' : ''}>Bottom</option>
        <option value="deco" ${g.use === 'deco' ? 'selected' : ''}>Deco</option>
        <option value="bailout" ${g.use === 'bailout' ? 'selected' : ''}>Bailout</option>
      </select></label>
      <label class="gas-switch-wrap" ${needsSwitch ? '' : 'hidden'}>
        <span>Switch (m)${g.switchAuto !== false ? ' <span class="auto-tag" title="Automatically suggested from the ppO₂ limits">auto</span>' : ''}</span>
        <input type="number" class="gas-switch" min="0" max="120" step="3" value="${g.switchDepth ?? 0}">
      </label>
      <span class="row-note">${note}</span>
      ${needsSwitch && g.switchAuto === false ? '<button type="button" class="btn btn-ghost btn-sm gas-switch-reset" title="Reset to the suggested depth">↺ Auto</button>' : ''}
      ${gasRows.length > 1 ? '<button class="btn btn-icon row-del" title="Remove gas">✕</button>' : ''}
      ${hypoxicAtSurface ? '<span class="row-warn">⚠ Hypoxic at the surface — add a Travel gas (or another Bottom gas) that clears the surface: whichever is safe there is used automatically, in any order, and this one’s switch depth is then suggested for you.</span>' : ''}
    </div>`;
  }).join('');

  box.querySelectorAll('.gas-row').forEach(row => {
    const i = +row.dataset.i;
    const sync = () => {
      gasRows[i].o2 = +row.querySelector('.gas-o2').value || 21;
      gasRows[i].he = +row.querySelector('.gas-he').value || 0;
      gasRows[i].use = row.querySelector('.gas-use').value;
      renderGasRows();
    };
    row.querySelectorAll('.gas-o2, .gas-he, .gas-use').forEach(inp => inp.addEventListener('change', sync));
    row.querySelector('.gas-switch')?.addEventListener('change', e => {
      gasRows[i].switchDepth = +e.target.value || 0;
      gasRows[i].switchAuto = false;
      renderGasRows();
    });
    row.querySelector('.gas-switch-reset')?.addEventListener('click', () => {
      gasRows[i].switchAuto = true;
      renderGasRows();
    });
    row.querySelector('.row-del')?.addEventListener('click', () => { gasRows.splice(i, 1); renderGasRows(); });
  });
}

/**
 * Tidy gasRows into dive order, then render. Only called right before
 * calculating a plan — adding/editing gases must never resort on its own, or
 * a row you've already set up (e.g. a bailout gas sorted last) can get
 * silently displaced by whatever you're adding or editing next.
 */
function sortAndRenderGasRows() {
  sortGasRows(primaryBottomRow(gasRows.filter(g => CHAIN_ROLES.includes(g.use))));
  renderGasRows();
}

function toLocalDT(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function plannedStartDate() {
  const v = $('#plan-start').value;
  const d = v ? new Date(v) : new Date();
  return isNaN(d) ? new Date() : d;
}

/** SI between the last logbook dive and the planned start (null if last dive undated). */
function siFromPlannedStart() {
  const last = logbook[logbook.length - 1];
  const lastEnd = last ? diveEndTime(last) : null;
  if (!lastEnd) return null;
  return Math.max(0, (plannedStartDate() - lastEnd) / 60000);
}

function refreshResidualHint() {
  const residual = currentResidual();
  const hint = $('#plan-residual-hint');
  const check = $('#plan-use-residual');

  // default planned start: an hour after the last dive ends, never in the past
  if (!$('#plan-start').value) {
    const last = logbook[logbook.length - 1];
    const lastEnd = last ? diveEndTime(last) : null;
    const def = new Date(Math.max(Date.now(), lastEnd ? lastEnd.getTime() + 60 * 60000 : 0));
    $('#plan-start').value = toLocalDT(def);
  }

  if (residual) {
    check.disabled = false;
    const si = siFromPlannedStart();
    $('#plan-si-wrap').hidden = si != null || !check.checked;
    if (si != null) {
      const lastLabel = residual.future ? 'Your last planned dive ends' : 'Your last dive ended';
      hint.textContent = `${lastLabel} ${fmtDate(diveEndTime(residual.dive).toISOString())} — ` +
        `surface interval to the planned start: ${fmtDur(si)}. ` +
        `Surfacing gradient at the end of the chain: ${residual.tissues.surfacingGF().toFixed(0)} %.`;
    } else {
      hint.textContent = `Last dive has no timestamp — enter the surface interval manually. ` +
        `Surfacing gradient: ${residual.tissues.surfacingGF().toFixed(0)} %.`;
    }
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

    sortAndRenderGasRows(); // tidy the gas list into dive order now that setup is (presumably) done
    const chain = gasRows.filter(g => CHAIN_ROLES.includes(g.use));
    const deco = gasRows.filter(g => g.use === 'deco').sort((a, b) => (b.switchDepth ?? 0) - (a.switchDepth ?? 0));
    const bailout = gasRows.filter(g => g.use === 'bailout');
    if (!chain.length) { toast('Add at least one Travel or Bottom gas.', 'warn'); return; }
    // whichever travel/bottom gas is safe at the surface is the one breathed
    // there (no switch depth); any other one is a deeper/leaner mix reached
    // via it and keeps its own switch depth — see the bottom-gas chain in deco.js.
    const primary = primaryBottomRow(chain);
    const gases = [...chain, ...deco, ...bailout].map(g => ({
      ...makeGas(g.o2 / 100, g.he / 100),
      use: g.use,
      switchDepth: CHAIN_ROLES.includes(g.use) && g === primary ? null : g.switchDepth,
    }));

    let startTissues = null;
    let siUsed = null;
    if ($('#plan-use-residual').checked) {
      const last = logbook[logbook.length - 1];
      if (last?.computed) {
        const si = siFromPlannedStart() ?? Math.max(0, +$('#plan-si').value || 0);
        siUsed = si;
        let t = Tissues.fromJSON(last.computed.tissuesEnd);
        t.surfaceP = settings.surfacePressure;
        startTissues = si > 0 ? surfaceInterval(t, si, settings.surfacePressure) : t;
      }
    }

    // safety stop is a global setting (Settings tab), not a per-plan toggle
    const safetyStopOn = settings.safetyStopEnabled;
    const safetyStopDepth = safetyStopOn ? settings.safetyStopDepth : null;
    const safetyStopMin = safetyStopOn ? settings.safetyStopMin : 0;

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
      safetyStopDepth,
      safetyStopMin,
    });
    lastPlan = plan;
    lastPlanInputs = {
      segments, gases, gfLow, gfHigh, siUsed, residual: !!startTissues, plannedStart: plannedStartDate(),
      safetyStop: safetyStopOn ? { depth: safetyStopDepth, min: safetyStopMin } : null,
    };
    renderPlanResults(plan, gases);
  } catch (e) {
    console.error(e);
    toast(`Planning failed: ${e.message}`, 'error');
  }
}

const SCHED_ICON = { descent: '↓', 'level-change': '↳', bottom: '■', ascent: '↑', stop: '◦' };

/**
 * Fold zero-duration 'switch' entries into the row that follows them, so a
 * gas change reads as a small ⇄ marker on that row's gas chip instead of its
 * own line — the schedule for a multi-gas plan can have a switch at nearly
 * every stop, and a dedicated row each time turns it into a wall of text.
 */
function foldSwitches(schedule) {
  const out = [];
  let pending = null;
  for (const s of schedule) {
    if (s.type === 'switch') { pending = s; continue; }
    out.push({ s, switched: !!pending });
    pending = null;
  }
  if (pending) out.push({ s: pending, switched: false, standalone: true }); // trailing switch, nothing to attach to
  return out;
}

/** Schedule table (thead+tbody) for either a live plan (`s.gas.name`) or a saved one (`s.gasName`). */
function scheduleTableHtml(schedule, gasNameOf) {
  const rows = foldSwitches(schedule).map(({ s, switched, standalone }) => {
    const depthText = standalone || ['descent', 'ascent', 'level-change'].includes(s.type)
      ? (standalone ? `${s.to.toFixed(0)} m` : `${s.from.toFixed(0)} → ${s.to.toFixed(0)} m`)
      : `${s.to.toFixed(0)} m`;
    const durText = standalone || !s.duration ? '—' : s.duration < 0.95 ? `${Math.round(s.duration * 60)} s` : fmtDur(s.duration);
    const phase = standalone ? 'gas switch' : s.type.replace('-', ' ');
    const icon = standalone ? '⇄' : (SCHED_ICON[s.type] || '');
    const gasChip = `${switched ? '<span class="switch-mark" title="Gas switch">⇄</span> ' : ''}<span class="gas-chip">${escapeHtml(gasNameOf(s))}</span>`;
    return `<tr class="sched-${standalone ? 'switch' : s.type}">
      <td>${icon} ${phase}</td>
      <td>${depthText}</td>
      <td>${durText}</td>
      <td>${Math.ceil(s.runtime)}</td>
      <td>${gasChip}</td>
    </tr>`;
  }).join('');
  return `<thead><tr><th>Phase</th><th>Depth</th><th>Duration</th><th>Runtime (min)</th><th>Gas</th></tr></thead><tbody>${rows}</tbody>`;
}

/**
 * Merge gas-usage rows that are actually the same mix (e.g. a travel gas
 * that's also carried as bailout, or two deco rows set to the same blend)
 * into one line, summing their litres — a physical cylinder doesn't care
 * which role the planner assigned its gas. Keeps first-seen order.
 */
function mergeGasUsage(gases, gasUsage) {
  const order = [];
  const byMix = new Map();
  gases.forEach((g, i) => {
    const key = `${g.o2}|${g.he}`;
    const modHere = mod(g, g.use === 'deco' ? settings.ppO2MaxDeco : settings.ppO2MaxBottom, settings.surfacePressure);
    let entry = byMix.get(key);
    if (!entry) {
      entry = { name: g.name, litres: 0, mod: modHere, hasBailout: false, hasOther: false };
      byMix.set(key, entry);
      order.push(entry);
    }
    entry.litres += gasUsage[i];
    entry.mod = Math.min(entry.mod, modHere);
    if (g.use === 'bailout') entry.hasBailout = true; else entry.hasOther = true;
  });
  return order;
}

/**
 * Final display rows for the "Gas requirements" table — merged by mix, with
 * litres already rounded to the ×10 L convention used everywhere else. This
 * is the shape saved onto a planned dive (see savePlanToLogbook), so the same
 * table can be redrawn later from the logbook without re-running the plan.
 */
function gasUsageRows(gases, gasUsage) {
  return mergeGasUsage(gases, gasUsage)
    .filter(({ litres, hasBailout }) => litres >= 1 || hasBailout)
    .map(({ name, mod: modDepth, litres, hasBailout }) => ({
      name,
      mod: Math.round(modDepth),
      required: litres < 1 ? null : Math.ceil(litres / 10) * 10,
      reserve: litres < 1 ? null : Math.ceil(litres * 1.5 / 10) * 10,
      hasBailout,
    }));
}

function gasUsageRowHtml(row) {
  // dives saved before the table gained MOD/reserve columns only stored {name, litres} —
  // fall back gracefully instead of showing "undefined" for those.
  const modDepth = row.mod ?? null;
  const required = row.required !== undefined ? row.required : (row.litres >= 1 ? Math.ceil(row.litres / 10) * 10 : null);
  const reserve = row.reserve !== undefined ? row.reserve : (row.litres >= 1 ? Math.ceil(row.litres * 1.5 / 10) * 10 : null);
  const nameHtml = `<span class="gas-chip">${escapeHtml(row.name)}</span>${row.hasBailout && required != null ? ' <span class="row-note">(also bailout)</span>' : ''}`;
  if (required == null) {
    return `<tr><td>${nameHtml}</td><td>${modDepth != null ? modDepth + ' m' : '—'}</td><td colspan="2">Carried as bailout — not breathed in this plan</td></tr>`;
  }
  return `<tr><td>${nameHtml}</td><td>${modDepth != null ? modDepth + ' m' : '—'}</td><td>${required} L</td><td>${reserve} L</td></tr>`;
}

/** Gas requirements table (thead+tbody) from already-computed rows (see gasUsageRows). */
function gasUsageTableHtml(rows) {
  return `<thead><tr><th>Gas</th><th>MOD</th><th>Required</th><th>With ⅓ reserve ×1.5</th></tr></thead>
    <tbody>${rows.map(gasUsageRowHtml).join('')}</tbody>`;
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

  $('#plan-schedule').innerHTML = scheduleTableHtml(plan.schedule, s => s.gas.name);

  renderTissueChart($('#plan-tissue-chart'), plan.tissuesEnd);

  $('#plan-gas-table').innerHTML = gasUsageTableHtml(gasUsageRows(gases, plan.gasUsage));

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
    datetime: (lastPlanInputs.plannedStart || new Date()).toISOString(),
    name: `Plan ${maxD} m / ${Math.round(lastPlanInputs.segments.reduce((s, x) => s + x.time, 0))} min`,
    site: '',
    notes: `Planned with GF ${Math.round(lastPlanInputs.gfLow * 100)}/${Math.round(lastPlanInputs.gfHigh * 100)}` +
      (lastPlanInputs.residual ? ` · repetitive (SI ${fmtDur(lastPlanInputs.siUsed)})` : '') +
      (lastPlanInputs.safetyStop ? ` · safety stop ${lastPlanInputs.safetyStop.depth} m / ${lastPlanInputs.safetyStop.min} min` : ''),
    source: 'plan',
    events: lastPlan.schedule.filter(s => s.type === 'switch')
      .map(s => ({ t: +s.runtime.toFixed(2), type: 'gas-switch', label: s.gas.name })),
    // full plan details, shown in the logbook and kept after "replace with actual"
    plan: {
      gfLow: Math.round(lastPlanInputs.gfLow * 100),
      gfHigh: Math.round(lastPlanInputs.gfHigh * 100),
      runtime: lastPlan.runtime,
      tts: lastPlan.tts,
      firstStop: lastPlan.firstStop,
      ndl: lastPlan.ndl,
      cns: lastPlan.cns,
      otu: lastPlan.otu,
      surfacingGF: lastPlan.surfacingGF,
      isDecoDive: lastPlan.isDecoDive,
      schedule: lastPlan.schedule.map(s => ({
        type: s.type, from: s.from, to: s.to,
        duration: +s.duration.toFixed(2), runtime: +s.runtime.toFixed(2),
        gasName: s.gas.name,
      })),
      gasUsage: gasUsageRows(lastPlanInputs.gases, lastPlan.gasUsage),
    },
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
      ${!planned && d.plan ? '<span class="src-chip ok" title="Planned dive replaced with actual data">✓ dived</span>' : ''}
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
    c.addEventListener('click', () => goToDiveDetail(c.dataset.id)));
}

function renderLogbook() {
  $('#logbook-detail').hidden = true;
  const list = $('#logbook-list');
  list.hidden = false;
  if (!logbook.length) {
    list.innerHTML = '<p class="empty">No dives yet. Import dive logs (UDDF, CSV or Garmin FIT) or save a plan from the planner.</p>';
    return;
  }
  list.innerHTML = [...logbook].reverse().map(diveCardHtml).join('');
  bindDiveCards(list);
}

/* --------------------------- sharing a plan ---------------------------- */

/** Fields worth handing to another diver — deliberately excludes id/computed/modifiedAt, which are only meaningful in the owner's own logbook. */
function curateShareDive(dive) {
  const { name, site, notes, gps, datetime, maxDepth, duration, gases, samples, events, plan } = dive;
  return { name, site, notes, gps, datetime, maxDepth, duration, gases, samples, events, plan };
}

async function shareDive(dive) {
  try {
    const id = await cloud.createShare(curateShareDive(dive));
    const url = `${location.origin}${location.pathname}#/shared/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied — send it to your buddy!', 'ok');
    } catch {
      prompt('Copy this link to share the plan:', url);
    }
  } catch (e) {
    toast(`Could not create a share link: ${e.message}`, 'error');
  }
}

async function loadSharedPlan(id) {
  const box = $('#view-shared');
  box.innerHTML = `<div class="hero hero-compact"><h1 class="hero-title">Loading shared plan…</h1></div>`;
  try {
    const { dive, sharedBy } = await cloud.fetchShare(id);
    renderSharedPlan(dive, sharedBy);
  } catch (e) {
    box.innerHTML = `
      <div class="hero hero-compact">
        <h1 class="hero-title">Link not found</h1>
        <p class="hero-sub">${escapeHtml(e.message || 'This share link is invalid or has expired.')}</p>
        <div class="hero-actions"><a href="#/" class="btn btn-outline btn-lg">Back to Abyss</a></div>
      </div>`;
  }
}

function renderSharedPlan(dive, sharedBy) {
  const box = $('#view-shared');
  box.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">${escapeHtml(diveTitle(dive))}</h1>
    </div>
    <div class="card shared-banner">
      <p class="card-hint">📤 Shared by <strong>${escapeHtml(sharedBy)}</strong>${dive.site ? ` · ${escapeHtml(dive.site)}` : ''}${dive.datetime ? ` · ${fmtDate(dive.datetime)}` : ''}</p>
      <p class="card-hint">Just want a look, or add this to your own logbook with ${escapeHtml(sharedBy)} recorded as your buddy?</p>
      <div class="account-actions">
        <button type="button" class="btn btn-outline" id="btn-shared-view-only">Just view it</button>
        <button type="button" class="btn btn-primary" id="btn-shared-add">Add to my logbook</button>
      </div>
      <p class="card-hint" id="shared-add-hint"></p>
    </div>
    ${dive.notes ? `<p class="card-hint">${escapeHtml(dive.notes)}</p>` : ''}
    <div class="card">
      <h2>Profile</h2>
      <p class="card-hint">Gases: ${escapeHtml(gasesLabel(dive.gases))}</p>
      <div id="shared-chart" class="chart-box"></div>
    </div>
    ${dive.plan ? `
    <div class="card plan-card">
      <h2>Planned schedule — GF ${dive.plan.gfLow}/${dive.plan.gfHigh}</h2>
      <div class="tile-row">
        <div class="tile"><span class="tile-value">${fmtDur(dive.plan.runtime)}</span><span class="tile-label">runtime</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.isDecoDive ? fmtDur(dive.plan.tts) : '—'}</span><span class="tile-label">deco (TTS)</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.isDecoDive ? dive.plan.firstStop + ' m' : 'no stop'}</span><span class="tile-label">first stop</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.surfacingGF.toFixed(0)} %</span><span class="tile-label">surfacing GF</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.cns.toFixed(0)} %</span><span class="tile-label">CNS</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.otu.toFixed(0)}</span><span class="tile-label">OTU</span></div>
      </div>
      <div class="table-scroll"><table class="table">${scheduleTableHtml(dive.plan.schedule, s => s.gasName)}</table></div>
      ${dive.plan.gasUsage?.length ? `
      <h2 class="mt">Gas requirements</h2>
      <div class="table-scroll"><table class="table">${gasUsageTableHtml(dive.plan.gasUsage)}</table></div>` : ''}
    </div>` : '<p class="empty">This shared dive has no plan details.</p>'}
    <div class="card">
      <h2>Tissue loading on surfacing</h2>
      <div id="shared-tissues" class="chart-box"></div>
    </div>
    <p class="card-hint"><a href="#/">← Back to Abyss</a></p>`;

  $('#btn-shared-view-only').addEventListener('click', () => {
    $('#shared-add-hint').textContent = "Just viewing — nothing has been added to your logbook.";
  });
  $('#btn-shared-add').addEventListener('click', () => addSharedToLogbook(dive, sharedBy));

  // --- profile + tissue charts, same replay as the logbook detail view ---
  const gases = diveGasObjects(dive);
  const samples = (dive.samples || []).map(s => ({ t: s.t, depth: s.depth, gas: gases[Math.min(s.gasIdx || 0, gases.length - 1)] }));
  if (samples.length) {
    const res = replayProfile(samples, null, SURFACE_PRESSURE);
    const events = diveEvents(dive, samples)
      .map(e => ({ ...e, depth: e.depth ?? depthAt(samples, e.t) }))
      .sort((a, b) => a.t - b.t);
    renderProfileChart($('#shared-chart'), res.profile, { events });
    renderTissueChart($('#shared-tissues'), res.tissues);
  }
}

function addSharedToLogbook(dive, sharedBy) {
  if (!cloud.getAccount()) {
    pendingSharedImport = { dive, sharedBy };
    $('#shared-add-hint').textContent = 'Sign in (or create a free account) to add this to your logbook — we\'ll finish adding it right after.';
    openAccountDialog();
    return;
  }
  completeSharedImport(dive, sharedBy);
}

function completeSharedImport(dive, sharedBy) {
  const newDive = { ...dive, id: store.newId(), buddy: sharedBy, source: 'plan' };
  logbook = store.addDives([newDive]);
  recomputeChain();
  scheduleSync();
  toast(`Added to your logbook — ${sharedBy} set as your buddy.`, 'ok');
  pendingLogbookDetailId = newDive.id;
  location.hash = '#/logbook';
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
        ${dive.plan ? '<button class="btn btn-outline btn-sm" id="btn-share-plan">🔗 Share plan</button>' : ''}
        <button class="btn btn-outline btn-sm" id="btn-edit-dive">✎ Edit dive</button>
        <button class="btn btn-danger btn-sm" id="btn-del-dive">Delete dive</button>
      </div>
    </div>
    ${dive.site || dive.buddy || mapLink ? `<p class="detail-meta">${escapeHtml(dive.site || '')}${dive.buddy ? `${dive.site ? ' · ' : ''}🤿 buddy: ${escapeHtml(dive.buddy)}` : ''} ${mapLink}</p>` : ''}

    <form class="card edit-form" id="dive-edit" hidden>
      <h2>Edit dive</h2>
      <div class="field-grid">
        <label>Name <input id="ed-name" value="${escapeHtml(dive.name || '')}" placeholder="e.g. Morning wall dive"></label>
        <label>Dive site <input id="ed-site" value="${escapeHtml(dive.site || '')}" placeholder="e.g. Blue Hole, Gozo"></label>
        <label>Buddy <input id="ed-buddy" value="${escapeHtml(dive.buddy || '')}" placeholder="e.g. Alex"></label>
        <label>Latitude <input id="ed-lat" type="number" step="any" min="-90" max="90" value="${dive.gps ? dive.gps.lat : ''}"></label>
        <label>Longitude <input id="ed-lon" type="number" step="any" min="-180" max="180" value="${dive.gps ? dive.gps.lon : ''}"></label>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-use-gps">📍 Use current location</button>
      <label class="mt">Notes <textarea id="ed-notes" rows="3" placeholder="Conditions, equipment, anything worth remembering…">${escapeHtml(dive.notes || '')}</textarea></label>
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
    ${dive.plan ? `
    <div class="card plan-card">
      <h2>${planned ? 'Planned schedule' : 'Original plan'} — GF ${dive.plan.gfLow}/${dive.plan.gfHigh}</h2>
      <div class="tile-row">
        <div class="tile"><span class="tile-value">${fmtDur(dive.plan.runtime)}</span><span class="tile-label">runtime</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.isDecoDive ? fmtDur(dive.plan.tts) : '—'}</span><span class="tile-label">deco (TTS)</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.isDecoDive ? dive.plan.firstStop + ' m' : 'no stop'}</span><span class="tile-label">first stop</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.surfacingGF.toFixed(0)} %</span><span class="tile-label">surfacing GF</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.cns.toFixed(0)} %</span><span class="tile-label">CNS</span></div>
        <div class="tile"><span class="tile-value">${dive.plan.otu.toFixed(0)}</span><span class="tile-label">OTU</span></div>
      </div>
      <div class="table-scroll">
        <table class="table">${scheduleTableHtml(dive.plan.schedule, s => s.gasName)}</table>
      </div>
      ${dive.plan.gasUsage?.length ? `
      <h2 class="mt">Gas requirements</h2>
      <div class="table-scroll">
        <table class="table">${gasUsageTableHtml(dive.plan.gasUsage)}</table>
      </div>` : ''}
    </div>` : ''}

    ${planned ? `
    <div class="card replace-card">
      <h2>Replace with actual dive data</h2>
      <p class="card-hint">Dived this plan? Import the recorded dive from your dive computer (UDDF, CSV or
        Garmin FIT) — the tissue chain and every following dive will then be computed from the real
        profile, not the plan. Your current and planned saturation stay separate until then.</p>
      <button type="button" class="btn btn-primary btn-sm" id="btn-replace-uddf">Import actual dive…</button>
      <p class="card-hint">Tip: importing on the Logbook page also works — a dive recorded within
        ±6 h of a plan's start replaces that plan automatically.</p>
    </div>` : ''}

    <div class="card">
      <h2>Events</h2>
      <p class="card-hint">Tip: tap a point on the profile above to set the event time automatically.</p>
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
  $('#btn-share-plan')?.addEventListener('click', () => shareDive(dive));
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
      buddy: $('#ed-buddy').value.trim(),
      gps,
      notes: $('#ed-notes').value.trim(),
    });
    scheduleSync();
    toast('Dive updated.', 'ok');
    showDiveDetail(dive.id);
  });

  // --- replace planned dive with an actual recorded dive (import only) ---
  function applyActual(patch) {
    logbook = store.updateDive(dive.id, {
      ...patch, source: 'dive', events: patch.events ?? null, surfaceIntervalMin: null,
    });
    recomputeChain();
    scheduleSync();
    toast('Plan replaced with actual dive data — tissue chain recomputed.', 'ok');
    showDiveDetail(dive.id);
    renderDashboard();
  }

  if (planned) {
    $('#btn-replace-uddf').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.uddf,.xml,application/xml,.csv,text/csv,.fit';
      inp.onchange = () => {
        const file = inp.files[0];
        if (!file) return;
        const format = importFormatFor(file.name);
        const reader = new FileReader();
        reader.onload = () => {
          const { dives, errors } = format === 'fit' ? parseFIT(reader.result)
            : format === 'csv' ? parseCSV(reader.result)
            : parseUDDF(reader.result);
          if (!dives.length) { toast(errors[0] || 'No dive found in that file.', 'error'); return; }
          const d = dives[0];
          applyActual({
            datetime: d.datetime || dive.datetime,
            maxDepth: d.maxDepth,
            duration: d.duration,
            gases: d.gases.map(g => ({ o2: g.o2, he: g.he, name: g.name })),
            samples: d.samples,
            gps: dive.gps || d.gps || null,
            buddy: dive.buddy || d.buddy || '',
          });
          if (dives.length > 1) toast('File held several dives — used the first one.', 'warn');
        };
        if (format === 'fit') reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
      };
      inp.click();
    });
  }

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
  renderProfileChart($('#detail-chart'), res.profile, {
    events,
    // tap the timeline to prefill the add-event time
    onTimeClick: t => {
      const rounded = Math.round(t * 2) / 2;
      $('#ev-time').value = rounded;
      const addRow = $('.event-add');
      addRow.classList.remove('flash');
      void addRow.offsetWidth; // restart animation
      addRow.classList.add('flash');
      addRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#ev-label').focus({ preventScroll: true });
    },
  });
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

const PLAN_MATCH_WINDOW_MS = 6 * 3600 * 1000;

/**
 * Imported dives that were recorded near a planned dive's start replace that
 * plan (keeping its name/site/plan for comparison); the rest are added new.
 * Returns how many plans were replaced.
 */
function absorbImportedDives(entries) {
  let replaced = 0;
  const taken = new Set();
  const toAdd = [];
  for (const e of entries) {
    const match = e.datetime && logbook.find(p =>
      p.source === 'plan' && !taken.has(p.id) && p.datetime &&
      Math.abs(new Date(p.datetime) - new Date(e.datetime)) < PLAN_MATCH_WINDOW_MS);
    if (match) {
      taken.add(match.id);
      logbook = store.updateDive(match.id, {
        datetime: e.datetime,
        maxDepth: e.maxDepth,
        duration: e.duration,
        gases: e.gases,
        samples: e.samples,
        gps: match.gps || e.gps || null,
        site: match.site || e.site,
        buddy: match.buddy || e.buddy || '',
        notes: match.notes || e.notes,
        source: 'dive',
        events: null,
        surfaceIntervalMin: null,
      });
      replaced++;
    } else {
      toAdd.push(e);
    }
  }
  logbook = toAdd.length ? store.addDives(toAdd) : store.loadLogbook();
  return replaced;
}

/** Which parser handles a file, by extension — content sniffing isn't worth it for three well-defined suffixes. */
function importFormatFor(filename) {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'csv') return 'csv';
  if (ext === 'fit') return 'fit';
  return 'uddf'; // .uddf, .xml, or unrecognized — parseUDDF reports a clear error either way
}

function importFiles(files) {
  if (!files.length) return;
  let imported = 0;
  let plansReplaced = 0;
  const allErrors = [];
  let pending = files.length;

  for (const file of files) {
    const format = importFormatFor(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const { dives, errors } = format === 'fit' ? parseFIT(reader.result)
        : format === 'csv' ? parseCSV(reader.result)
        : parseUDDF(reader.result);
      allErrors.push(...errors.map(e => file.name + ': ' + e));
      if (dives.length) {
        const entries = dives.map(d => ({
          id: store.newId(),
          datetime: d.datetime,
          site: d.site || file.name.replace(/\.[a-z0-9]+$/i, ''),
          gps: d.gps || null,
          buddy: d.buddy || '',
          notes: d.notes,
          source: format,
          maxDepth: d.maxDepth,
          duration: d.duration,
          surfaceIntervalMin: d.surfaceIntervalMin,
          gases: d.gases.map(g => ({ o2: g.o2, he: g.he, name: g.name })),
          samples: d.samples,
        }));
        plansReplaced += absorbImportedDives(entries);
        imported += entries.length;
      }
      if (--pending === 0) {
        recomputeChain();
        scheduleSync();
        if (imported) {
          toast(`Imported ${imported} dive${imported > 1 ? 's' : ''}` +
            (plansReplaced ? ` — ${plansReplaced} replaced planned dive${plansReplaced > 1 ? 's' : ''}` : '') +
            '. Tissue chains computed.', 'ok');
          location.hash = '#/logbook';
          renderLogbook();
          renderDashboard();
        }
        if (allErrors.length) toast(allErrors[0], 'warn');
      }
    };
    reader.onerror = () => { allErrors.push(`Could not read ${file.name}`); if (--pending === 0 && allErrors.length) toast(allErrors[0], 'error'); };
    if (format === 'fit') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
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

const SETTING_FIELDS = ['gfLow', 'gfHigh', 'lastStopDepth', 'surfacePressure', 'descentRate', 'ascentRate', 'sacBottom', 'sacDeco', 'ppO2MaxBottom', 'ppO2MaxDeco', 'safetyStopDepth', 'safetyStopMin'];

function renderSettings() {
  for (const f of SETTING_FIELDS) {
    const input = $(`#set-${f}`);
    if (input) input.value = settings[f];
  }
  $('#set-safetyStopEnabled').checked = settings.safetyStopEnabled;
  $('#set-safety-stop-wrap').hidden = !settings.safetyStopEnabled;
  refreshSafetyStopHint();
}

function saveSettingsFromForm() {
  for (const f of SETTING_FIELDS) {
    const input = $(`#set-${f}`);
    if (input) {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) settings[f] = v;
    }
  }
  settings.safetyStopEnabled = $('#set-safetyStopEnabled').checked;
  store.saveSettings(settings);
  store.touchSettings();
  recomputeChain();
  renderGasRows(); // refresh MOD notes + auto-suggested switch depths for the new ppO₂/surface-pressure settings
  refreshSafetyStopHint();
  scheduleSync();
  toast('Settings saved.', 'ok');
}

/** Safety-stop hint shown in the planner — the setting itself lives in Settings, not per plan. */
function refreshSafetyStopHint() {
  const hint = $('#plan-safety-stop-hint');
  if (!hint) return;
  hint.textContent = settings.safetyStopEnabled
    ? `Safety stop: ${settings.safetyStopDepth} m for ${settings.safetyStopMin} min, added to every plan (change in Settings).`
    : 'No safety stop configured — enable one in Settings to add it to every plan.';
}

/* --------------------------- cloud account ---------------------------- */

let lastSyncAt = null;
let syncTimer = null;
let lastServerStamp = null; // server doc stamp after our last sync — drives change polling
let syncInFlight = false;
const SYNC_DEBOUNCE_MS = 400;
const SYNC_POLL_MS = 10000;

function refreshAccountUI() {
  const acc = cloud.getAccount();
  $('#btn-account').textContent = acc ? acc.email.split('@')[0] : 'Sign in';
  $('#btn-account').classList.toggle('signed-in', !!acc);
  $('#account-signed-out').hidden = !!acc;
  $('#account-signed-in').hidden = !acc;
  $('#btn-account-close').textContent = acc ? 'Close' : 'Cancel';
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
  syncTimer = setTimeout(() => doSync({ silent: true }), SYNC_DEBOUNCE_MS);
}

async function doSync({ silent = false } = {}) {
  const acc = cloud.getAccount();
  if (!acc || syncInFlight) return;
  syncInFlight = true;
  try {
    const result = await cloud.syncLogbook(logbook, store.loadTombstones(), settings, store.settingsUpdatedAt());
    lastSyncAt = new Date();
    lastServerStamp = result.serverUpdatedAt;
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
      route();
      toast(e.message, 'warn');
    } else if (!silent && e.kind === 'offline') {
      toast(e.message, 'warn');
    } else if (!silent) {
      toast(`Sync failed: ${e.message}`, 'error');
    }
    // offline in silent mode: ignore — the 'online' listener will retry
  } finally {
    syncInFlight = false;
  }
  refreshAccountUI();
}

/**
 * Fast pull: poll the cheap /api/logbook/meta stamp and run a full sync only
 * when another device changed something — keeps two open devices converging
 * within seconds without hammering the server.
 */
async function pollRemoteChanges() {
  if (!cloud.getAccount() || !navigator.onLine || document.hidden || syncInFlight) return;
  try {
    const meta = await cloud.remoteMeta();
    if (meta.updatedAt && meta.updatedAt !== lastServerStamp) await doSync({ silent: true });
  } catch { /* offline or expired — doSync paths handle those states */ }
}

function openAccountDialog() {
  $('#account-error').hidden = true;
  refreshAccountUI();
  $('#account-dialog').showModal();
}

function initAccount() {
  const dialog = $('#account-dialog');
  const errBox = $('#account-error');
  const showErr = msg => { errBox.textContent = msg; errBox.hidden = false; };

  $('#btn-account').addEventListener('click', openAccountDialog);
  $('#btn-account-settings').addEventListener('click', openAccountDialog);
  $('#btn-landing-signin').addEventListener('click', openAccountDialog);
  $('#btn-sync-now').addEventListener('click', () => doSync());

  const credentials = () => ({
    email: $('#acc-email').value.trim(),
    password: $('#acc-password').value,
  });

  async function doAuth(fn, label, isLogin) {
    const { email, password } = credentials();
    if (!email || password.length < 8) { showErr('Enter your email and a password of at least 8 characters.'); return; }
    try {
      await fn(email, password);
      $('#acc-password').value = '';
      errBox.hidden = true;
      toast(`${label} as ${email}. Syncing logbook…`, 'ok');
      await doSync({ silent: true });
      refreshAccountUI();
      dialog.close();
      if (pendingSharedImport) {
        const { dive, sharedBy } = pendingSharedImport;
        pendingSharedImport = null;
        completeSharedImport(dive, sharedBy);
      } else {
        route();
      }
    } catch (e) {
      // the server keeps "wrong password" and "no such account" indistinguishable
      // on purpose (security) — nudge toward registering, since that's the far
      // more common cause of a failed first sign-in.
      showErr(isLogin && /wrong email or password/i.test(e.message)
        ? `${e.message} Not registered yet? Use “Create account” instead.`
        : e.message);
    }
  }

  $('#btn-do-login').addEventListener('click', () => doAuth(cloud.login, 'Signed in', true));
  $('#btn-do-register').addEventListener('click', () => doAuth(cloud.register, 'Account created', false));
  $('#btn-do-logout').addEventListener('click', async () => {
    await cloud.logout();
    lastSyncAt = null;
    $('#acc-email').value = '';
    $('#acc-password').value = '';
    refreshAccountUI();
    dialog.close();
    route();
    toast('Signed out. The logbook stays on this device.', 'ok');
  });
  $('#btn-do-sync').addEventListener('click', () => doSync());

  // reconnects push local changes up automatically
  window.addEventListener('online', () => doSync({ silent: true }));
  // returning to the tab pulls the latest state immediately
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemoteChanges(); });
  // steady change-poll keeps simultaneously open devices in step
  setInterval(pollRemoteChanges, SYNC_POLL_MS);

  refreshAccountUI();
  if (cloud.getAccount() && navigator.onLine) doSync({ silent: true });
}

/* -------------------------------- mobile -------------------------------- */

/**
 * Keep the fixed bottom tab bar pinned to the bottom of what's actually
 * visible when the on-screen keyboard opens. `position: fixed; bottom: 0`
 * alone anchors to the *layout* viewport, which mobile browsers don't shrink
 * for the keyboard — so without this the bar ends up hidden behind it (or
 * floating mid-screen once the browser scrolls the focused field into view).
 * The visualViewport API reports the part of the page actually on screen, so
 * nudging the bar up by however much has been covered keeps it in place.
 */
function initMobileKeyboardFix() {
  const vv = window.visualViewport;
  if (!vv) return; // older browser — bar stays put, matching pre-fix behavior
  const nav = $('.nav');
  const reposition = () => {
    const covered = window.innerHeight - vv.height - vv.offsetTop;
    nav.style.transform = covered > 1 ? `translateY(-${covered}px)` : '';
  };
  vv.addEventListener('resize', reposition);
  vv.addEventListener('scroll', reposition);
}

/* -------------------------------- PWA --------------------------------- */

let deferredInstall = null;

function initPWA() {
  if ('serviceWorker' in navigator) {
    // Fires once a new worker actually takes over. skipWaiting()+clients.claim()
    // in sw.js mean this can happen without any user action — but it *also*
    // fires the very first time a page gets claimed at all, which isn't an
    // update, just first install; only announce when a controller is being
    // replaced, not acquired for the first time.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) announceUpdateAvailable();
      hadController = true;
    });
    navigator.serviceWorker.register('sw.js').then(reg => {
      // The browser only checks for a changed sw.js on its own schedule (as
      // infrequently as once a day) — far too slow on a phone that's mostly
      // reopened from the home screen rather than freshly navigated to. Ask
      // explicitly right away, and again every time the app comes back to
      // the foreground, so a stale worker gets replaced promptly.
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      window.addEventListener('pageshow', () => reg.update().catch(() => {}));
    }).catch(e => console.warn('SW registration failed', e));
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

/** Manual "force update": drop the service worker + its cache, then reload to fetch everything fresh. */
async function clearCacheAndReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) {
    console.warn('Cache clear failed', e);
  } finally {
    location.reload();
  }
}

/**
 * "A new version is available" notice — from either signal: the server
 * restarting (pushed live over SSE) or a new service worker taking control
 * on this device (see initPWA). Only announces once per page load.
 */
let updateAnnounced = false;
function announceUpdateAvailable() {
  if (updateAnnounced) return;
  updateAnnounced = true;
  const status = $('#set-update-status');
  if (status) status.textContent = 'A new version is available.';
  toast('A new version is available — tap to refresh.', 'ok', { sticky: true, onClick: clearCacheAndReload });
}

/** Live "a new version is deployed" notice, pushed by the server (see sync.subscribeToUpdates) rather than polled for. */
function initUpdateCheck() {
  cloud.subscribeToUpdates(() => announceUpdateAvailable());
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
    gasRows.push({ o2: 50, he: 0, use: 'deco', switchDepth: null, switchAuto: true });
    renderGasRows();
  });
  $('#btn-plan').addEventListener('click', runPlan);
  $('#btn-save-plan').addEventListener('click', savePlanToLogbook);
  $('#plan-use-residual').addEventListener('change', refreshResidualHint);
  $('#plan-start').addEventListener('change', refreshResidualHint);
  $('#set-safetyStopEnabled').addEventListener('change', e => { $('#set-safety-stop-wrap').hidden = !e.target.checked; });

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
  $('#btn-clear-cache').addEventListener('click', () => {
    if (!confirm('Clear the cached app files and reload? Any unsaved planner input will be lost — your logbook and settings are unaffected.')) return;
    clearCacheAndReload();
  });

  window.addEventListener('hashchange', route);
  route();
  initAccount();
  initPWA();
  initUpdateCheck();
  initMobileKeyboardFix();

  // saturation off-gasses in real time — keep the dashboard ticking
  setInterval(() => {
    if (!document.hidden && $('#view-dashboard').classList.contains('active')) renderDashboard();
  }, 30000);
}

init();
