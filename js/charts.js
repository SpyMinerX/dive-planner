/*
 * charts.js — hand-rolled SVG charts.
 *
 * Palette (validated for the app's dark surface #0c1626):
 *   series-1 blue   #3987e5  (depth / N2)
 *   series-2 orange #d95926  (ceiling / He)
 *   series-3 green  #199e70
 *   series-4 yellow #c98500
 * Ink: primary #f2f5f9, secondary #aab6c6, muted #7c8aa0, grid #1c2b42, axis #2b3d5c
 */

const INK = { primary: '#f2f5f9', secondary: '#aab6c6', muted: '#7c8aa0', grid: '#1c2b42', axis: '#2b3d5c' };
export const SERIES = { depth: '#3987e5', ceiling: '#d95926', n2: '#3987e5', he: '#d95926', green: '#199e70', yellow: '#c98500' };

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent = null) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function fmtTime(min) {
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return s ? `${m}:${String(s).padStart(2, '0')}` : `${m} min`;
}

function niceStep(range, targetTicks) {
  const rough = range / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const m of [1, 2, 5, 10]) if (rough <= m * pow) return m * pow;
  return 10 * pow;
}

/* ------------------------------------------------------------------ */
/* Dive profile chart: depth vs time, with deco ceiling                */
/* ------------------------------------------------------------------ */

// event marker palette: color + glyph, never color alone
export const EVENT_STYLE = {
  'gas-switch':  { color: '#199e70', glyph: '⇄', name: 'Gas switch' },
  'emergency':   { color: '#d03b3b', glyph: '⚠', name: 'Emergency' },
  'wildlife':    { color: '#3987e5', glyph: '✳', name: 'Sighting' },
  'note':        { color: '#c98500', glyph: '✎', name: 'Note' },
  'deco-stop':   { color: '#d95926', glyph: '⏸', name: 'Deco stop' },
  'safety-stop': { color: '#2dd4ea', glyph: '✓', name: 'Safety stop' },
};

/**
 * @param container HTMLElement (emptied)
 * @param profile   [{t, depth, ceiling?, gas?}]
 * @param opts      { showCeiling, events: [{t, depth, type, label}], height }
 *
 * Supports zooming into the time axis: mouse wheel / trackpad (anchored at
 * the cursor), two-finger pinch on touch (anchored at the pinch midpoint,
 * with simultaneous panning), mouse click-drag to pan once zoomed in, and
 * double-click or the on-chart button to reset. The depth axis stays fixed
 * — only the time window changes — so zooming in is for inspecting a
 * cluster of closely-spaced stops/events, not exaggerating depth.
 */
export function renderProfileChart(container, profile, opts = {}) {
  container.innerHTML = '';
  if (!profile || profile.length < 2) {
    container.innerHTML = '<p class="chart-empty">No profile data.</p>';
    return;
  }
  const H = opts.height || 300;
  const W = Math.max(320, container.clientWidth || 640);
  const pad = { top: 18, right: 16, bottom: 34, left: 44 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const tMaxFull = profile[profile.length - 1].t;
  const dMax = Math.max(3, Math.max(...profile.map(p => Math.max(p.depth, p.ceiling || 0)))) * 1.08;
  const y = d => pad.top + (d / dMax) * ih; // depth grows downward — fixed, never zoomed
  const hasCeiling = opts.showCeiling !== false && profile.some(p => (p.ceiling || 0) > 0.05);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart profile-chart', role: 'img', 'aria-label': 'Dive profile: depth over time' });
  svg.style.touchAction = 'none'; // we own all touch gestures here (pinch-zoom, pan)
  container.appendChild(svg);
  container.style.position = 'relative';

  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.style.display = 'none';
  container.appendChild(tip);

  const zoomBtn = document.createElement('button');
  zoomBtn.type = 'button';
  zoomBtn.className = 'chart-zoom-btn';
  container.appendChild(zoomBtn);

  // interpolate a point on the (piecewise-linear) profile at an arbitrary time
  function interp(t) {
    const hi0 = profile.length - 1;
    if (t <= profile[0].t) return { t, depth: profile[0].depth, ceiling: profile[0].ceiling || 0, gas: profile[0].gas };
    if (t >= profile[hi0].t) return { t, depth: profile[hi0].depth, ceiling: profile[hi0].ceiling || 0, gas: profile[hi0].gas };
    let lo = 0, hi = hi0;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (profile[mid].t < t) ? lo = mid : hi = mid; }
    const a = profile[lo], b = profile[hi];
    const f = (b.t - a.t) ? (t - a.t) / (b.t - a.t) : 0;
    return { t, depth: a.depth + (b.depth - a.depth) * f, ceiling: (a.ceiling || 0) + ((b.ceiling || 0) - (a.ceiling || 0)) * f, gas: a.gas };
  }

  const minSpan = Math.min(tMaxFull, Math.max(0.5, tMaxFull / 30));
  let domain = [0, tMaxFull]; // current visible [tMin, tMax]
  const isZoomed = () => domain[0] > 1e-6 || domain[1] < tMaxFull - 1e-6;
  function clampDomain(t0, t1) {
    let span = Math.max(minSpan, Math.min(tMaxFull, t1 - t0));
    if (t0 < 0) t0 = 0;
    if (t0 + span > tMaxFull) t0 = tMaxFull - span;
    if (t0 < 0) t0 = 0;
    return [t0, t0 + span];
  }
  const xOf = t => { const [tMin, tMax] = domain; return pad.left + ((t - tMin) / (tMax - tMin || 1)) * iw; };
  const tAtClientX = clientX => {
    const [tMin, tMax] = domain;
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) * (W / rect.width);
    return tMin + Math.max(0, Math.min(1, (px - pad.left) / iw)) * (tMax - tMin);
  };

  // elements rebuilt on every draw() — referenced by the gesture handlers below
  let capture, hoverG, vline, dot, cdot;

  let rafId = null;
  function scheduleDraw() { if (rafId == null) rafId = requestAnimationFrame(() => { rafId = null; draw(); }); }

  function hideHover() { if (hoverG) hoverG.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
  function showHoverAt(clientX) {
    const [tMin, tMax] = domain;
    const t = Math.max(tMin, Math.min(tMax, tAtClientX(clientX)));
    const p = interp(t);
    const cx = xOf(p.t);
    vline.setAttribute('x1', cx); vline.setAttribute('x2', cx);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', y(p.depth));
    if (hasCeiling && (p.ceiling || 0) > 0.05) {
      cdot.setAttribute('visibility', 'visible');
      cdot.setAttribute('cx', cx); cdot.setAttribute('cy', y(p.ceiling));
    } else cdot.setAttribute('visibility', 'hidden');
    hoverG.setAttribute('visibility', 'visible');
    tip.innerHTML = `<strong>${fmtTime(p.t)}</strong><br>Depth ${p.depth.toFixed(1)} m` +
      (hasCeiling ? `<br>Ceiling ${(p.ceiling || 0).toFixed(1)} m` : '') +
      (p.gas ? `<br>${p.gas.name}` : '');
    tip.style.display = 'block';
  }
  function positionTip(clientX, clientY) {
    const contRect = container.getBoundingClientRect();
    const tx = clientX - contRect.left;
    tip.style.left = Math.min(tx + 14, contRect.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.max(4, clientY - contRect.top - tip.offsetHeight - 12) + 'px';
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const [tMin, tMax] = domain;
    const span = tMax - tMin || 1;
    const x = xOf;

    // depth gradient fill + a clip so panned/zoomed lines never spill past the axes
    const defs = el('defs', {}, svg);
    const grad = el('linearGradient', { id: 'depthFill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', 'stop-color': SERIES.depth, 'stop-opacity': 0.30 }, grad);
    el('stop', { offset: '100%', 'stop-color': SERIES.depth, 'stop-opacity': 0.04 }, grad);
    const clip = el('clipPath', { id: 'plotClip' }, defs);
    el('rect', { x: pad.left, y: pad.top, width: iw, height: ih }, clip);

    // grid + axes
    const dStep = niceStep(dMax, 5);
    for (let d = 0; d <= dMax; d += dStep) {
      el('line', { x1: pad.left, x2: pad.left + iw, y1: y(d), y2: y(d), stroke: d === 0 ? INK.axis : INK.grid, 'stroke-width': 1 }, svg);
      const lbl = el('text', { x: pad.left - 8, y: y(d) + 4, 'text-anchor': 'end', class: 'tick' }, svg);
      lbl.textContent = `${d}`;
    }
    const tStep = niceStep(span, 6);
    const tStart = Math.ceil(tMin / tStep) * tStep;
    for (let t = tStart; t <= tMax + 1e-9; t += tStep) {
      const lbl = el('text', { x: x(t), y: pad.top + ih + 20, 'text-anchor': 'middle', class: 'tick' }, svg);
      lbl.textContent = `${Math.round(t)}`;
    }
    const yTitle = el('text', { x: 12, y: pad.top - 6, class: 'axis-title' }, svg);
    yTitle.textContent = 'm';
    const xTitle = el('text', { x: pad.left + iw, y: pad.top + ih + 20, 'text-anchor': 'end', class: 'axis-title' }, svg);
    xTitle.textContent = 'min';

    // visible slice of the profile, with interpolated points at the domain edges
    const visible = profile.filter(p => p.t >= tMin && p.t <= tMax);
    if (!visible.length || visible[0].t > tMin + 1e-9) visible.unshift(interp(tMin));
    if (visible[visible.length - 1].t < tMax - 1e-9) visible.push(interp(tMax));

    // ceiling (dashed, drawn under the depth line)
    if (hasCeiling) {
      const cd = visible.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.ceiling || 0).toFixed(1)}`).join('');
      el('path', { d: cd, fill: 'none', stroke: SERIES.ceiling, 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round', 'clip-path': 'url(#plotClip)' }, svg);
    }

    // depth area + line
    const line = visible.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.depth).toFixed(1)}`).join('');
    el('path', { d: `${line}L${x(tMax).toFixed(1)},${y(0)}L${x(tMin).toFixed(1)},${y(0)}Z`, fill: 'url(#depthFill)', stroke: 'none', 'clip-path': 'url(#plotClip)' }, svg);
    el('path', { d: line, fill: 'none', stroke: SERIES.depth, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'clip-path': 'url(#plotClip)' }, svg);

    // event markers (gas switches, emergencies, deco/safety stops, …) — only those in view
    for (const ev of opts.events || []) {
      if (ev.t < tMin - 1e-6 || ev.t > tMax + 1e-6) continue;
      const st = EVENT_STYLE[ev.type] || EVENT_STYLE.note;
      const cx = x(ev.t), cy = y(Math.max(0, Math.min(dMax, ev.depth)));
      const g = el('g', { class: 'event-marker' }, svg);
      el('circle', { cx, cy, r: 8, fill: st.color, stroke: '#0c1626', 'stroke-width': 2 }, g);
      const glyph = el('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', class: 'event-glyph' }, g);
      glyph.textContent = st.glyph;
      if (!ev.noLabel) {
        const lbl = el('text', { x: cx + 12, y: cy + 4, class: 'mark-label' }, g);
        lbl.textContent = ev.label || st.name;
      }
      const tt = el('title', {}, g);
      tt.textContent = `${st.name}${ev.label ? ': ' + ev.label : ''} — ${fmtTime(ev.t)} at ${ev.depth.toFixed(0)} m`;
    }

    // legend (2 series → required)
    if (hasCeiling) {
      const lg = el('g', { class: 'legend', transform: `translate(${pad.left + 8}, ${pad.top + 4})` }, svg);
      el('rect', { x: -6, y: -12, width: 148, height: 40, rx: 6, fill: '#0c1626', opacity: 0.82 }, lg);
      el('line', { x1: 0, y1: -2, x2: 18, y2: -2, stroke: SERIES.depth, 'stroke-width': 2 }, lg);
      let t1 = el('text', { x: 24, y: 2, class: 'legend-label' }, lg); t1.textContent = 'Depth';
      el('line', { x1: 0, y1: 16, x2: 18, y2: 16, stroke: SERIES.ceiling, 'stroke-width': 2, 'stroke-dasharray': '5 4' }, lg);
      let t2 = el('text', { x: 24, y: 20, class: 'legend-label' }, lg); t2.textContent = 'Deco ceiling';
    }

    // ---- hover layer: crosshair + tooltip ----
    hoverG = el('g', { class: 'hover-layer', visibility: 'hidden' }, svg);
    vline = el('line', { y1: pad.top, y2: pad.top + ih, stroke: INK.muted, 'stroke-width': 1, 'stroke-dasharray': '3 3' }, hoverG);
    dot = el('circle', { r: 4.5, fill: SERIES.depth, stroke: '#0c1626', 'stroke-width': 2 }, hoverG);
    cdot = el('circle', { r: 4, fill: SERIES.ceiling, stroke: '#0c1626', 'stroke-width': 2 }, hoverG);

    capture = el('rect', {
      x: pad.left, y: pad.top, width: iw, height: ih, fill: 'transparent', class: 'capture',
      style: opts.onTimeClick ? 'cursor: crosshair' : 'cursor: default',
    }, svg);

    const zoomed = isZoomed();
    zoomBtn.textContent = zoomed ? '↺ Reset zoom' : '🔍 Scroll or pinch to zoom';
    zoomBtn.classList.toggle('is-reset', zoomed);
  }

  zoomBtn.addEventListener('click', () => { domain = [0, tMaxFull]; draw(); });
  svg.addEventListener('dblclick', e => { e.preventDefault(); domain = [0, tMaxFull]; draw(); });

  // ---- gesture state (persists across draw() calls, which only rebuild the SVG's children) ----
  const pointers = new Map(); // pointerId -> {x, y}
  let gesture = null; // 'pinch' | 'pan' | null
  let pinchStart = null; // { dist, midClientX, domain }
  let panStart = null;   // { clientX, domain }
  let dragMoved = false;
  let suppressClick = false;

  const dist2 = pts => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  const midX2 = pts => (pts[0].x + pts[1].x) / 2;

  svg.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragMoved = false;
    // only capture the pointer once we know a gesture is actually starting —
    // capturing on every plain tap/click retargets the subsequent click event
    // to the svg itself (per the Pointer Events spec), breaking onTimeClick.
    if (pointers.size === 2) {
      gesture = 'pinch';
      hideHover();
      const pts = [...pointers.values()];
      pinchStart = { dist: Math.max(1, dist2(pts)), midClientX: midX2(pts), domain: domain.slice() };
      for (const id of pointers.keys()) { try { svg.setPointerCapture(id); } catch { /* ignore */ } }
    } else if (pointers.size === 1 && e.pointerType !== 'touch' && (e.buttons & 1) && isZoomed()) {
      gesture = 'pan';
      panStart = { clientX: e.clientX, domain: domain.slice() };
      try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  });

  svg.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture === 'pinch' && pointers.size >= 2) {
      e.preventDefault();
      dragMoved = true;
      const pts = [...pointers.values()].slice(0, 2);
      const dist = Math.max(1, dist2(pts));
      const midNow = midX2(pts);
      const [st0, st1] = pinchStart.domain;
      const startSpan = st1 - st0;
      const anchorT = st0 + Math.max(0, Math.min(1, ((pinchStart.midClientX - svg.getBoundingClientRect().left) * (W / svg.getBoundingClientRect().width) - pad.left) / iw)) * startSpan;
      const scaleFactor = Math.max(0.05, dist / pinchStart.dist);
      const newSpan = Math.max(minSpan, Math.min(tMaxFull, startSpan / scaleFactor));
      const nowFrac = Math.max(0, Math.min(1, ((midNow - svg.getBoundingClientRect().left) * (W / svg.getBoundingClientRect().width) - pad.left) / iw));
      const newT0 = anchorT - nowFrac * newSpan;
      domain = clampDomain(newT0, newT0 + newSpan);
      scheduleDraw();
      return;
    }
    if (gesture === 'pan' && panStart) {
      e.preventDefault();
      dragMoved = true;
      const deltaPx = e.clientX - panStart.clientX;
      const [t0, t1] = panStart.domain;
      const deltaT = -(deltaPx / iw) * (t1 - t0);
      domain = clampDomain(t0 + deltaT, t1 + deltaT);
      scheduleDraw();
      return;
    }
    // plain hover — only within the plot area, and only while not mid-gesture
    const rect = svg.getBoundingClientRect();
    const localX = (e.clientX - rect.left) * (W / rect.width);
    const localY = (e.clientY - rect.top) * (H / rect.height);
    if (e.target !== capture || localX < pad.left || localX > pad.left + iw || localY < pad.top || localY > pad.top + ih) {
      hideHover();
      return;
    }
    showHoverAt(e.clientX);
    positionTip(e.clientX, e.clientY);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (gesture === 'pinch' && pointers.size < 2) { gesture = null; pinchStart = null; }
    if (gesture === 'pan' && pointers.size < 1) { gesture = null; panStart = null; }
    if (dragMoved) { suppressClick = true; dragMoved = false; }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', () => { if (!gesture) hideHover(); });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const [tMin, tMax] = domain;
    const span = tMax - tMin;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    const frac = Math.max(0, Math.min(1, (px - pad.left) / iw));
    const anchorT = tMin + frac * span;
    const zoomFactor = Math.exp(-e.deltaY * 0.0018);
    const newSpan = Math.max(minSpan, Math.min(tMaxFull, span / zoomFactor));
    const newT0 = anchorT - frac * newSpan;
    domain = clampDomain(newT0, newT0 + newSpan);
    scheduleDraw();
  }, { passive: false });

  svg.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    if (!opts.onTimeClick || e.target !== capture) return;
    opts.onTimeClick(tAtClientX(e.clientX));
  });

  draw();
}

/* ------------------------------------------------------------------ */
/* Tissue saturation chart: 16 compartments, N2 + He stacked           */
/* ------------------------------------------------------------------ */

/**
 * @param container HTMLElement
 * @param tissues   Tissues instance
 * @param opts      { ambientP } pressure at which saturation is evaluated (default surface)
 */
export function renderTissueChart(container, tissues, opts = {}) {
  container.innerHTML = '';
  const ambientP = opts.ambientP ?? tissues.surfaceP;
  const n = tissues.pN2.length;

  const W = Math.max(320, container.clientWidth || 640);
  const rowH = 16, gap = 2;
  const pad = { top: 30, right: 16, bottom: 30, left: 34 };
  const H = pad.top + n * (rowH + gap) + pad.bottom;
  const iw = W - pad.left - pad.right;

  const totals = tissues.pN2.map((p, i) => p + tissues.pHe[i]);
  const maxP = Math.max(ambientP * 1.25, ...totals) * 1.06;
  const x = p => pad.left + (p / maxP) * iw;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart tissue-chart', role: 'img', 'aria-label': 'Tissue compartment inert gas loading' });
  container.appendChild(svg);

  // grid
  const step = niceStep(maxP, 5);
  for (let p = 0; p <= maxP; p += step) {
    el('line', { x1: x(p), x2: x(p), y1: pad.top - 4, y2: H - pad.bottom, stroke: p === 0 ? INK.axis : INK.grid, 'stroke-width': 1 }, svg);
    const lbl = el('text', { x: x(p), y: H - pad.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg);
    lbl.textContent = p.toFixed(1);
  }
  const xt = el('text', { x: pad.left + iw, y: H - pad.bottom + 16, 'text-anchor': 'end', class: 'axis-title' }, svg);
  xt.textContent = 'bar';

  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.style.display = 'none';
  container.style.position = 'relative';
  container.appendChild(tip);

  const hasHe = tissues.pHe.some(v => v > 0.001);

  for (let i = 0; i < n; i++) {
    const yTop = pad.top + i * (rowH + gap);
    const wN2 = Math.max(0, x(tissues.pN2[i]) - pad.left);
    const wHe = Math.max(0, (tissues.pHe[i] / maxP) * iw);

    const g = el('g', { class: 'tissue-row' }, svg);
    // N2 segment — rounded data-end only when it's the outer end
    el('rect', { x: pad.left, y: yTop, width: Math.max(wN2, 0.5), height: rowH, rx: wHe > 0.5 ? 0 : 3, fill: SERIES.n2 }, g);
    if (wHe > 0.5) {
      el('rect', { x: pad.left + wN2 + 2, y: yTop, width: wHe, height: rowH, rx: 3, fill: SERIES.he }, g);
    }
    const lbl = el('text', { x: pad.left - 6, y: yTop + rowH - 4, 'text-anchor': 'end', class: 'tick' }, svg);
    lbl.textContent = i + 1;

    const gf = tissues.compartmentGF(i, ambientP);
    const hit = el('rect', { x: pad.left, y: yTop - gap / 2, width: iw, height: rowH + gap, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', ev => {
      tip.innerHTML = `<strong>Compartment ${i + 1}</strong><br>` +
        `N₂ ${tissues.pN2[i].toFixed(3)} bar` +
        (hasHe ? `<br>He ${tissues.pHe[i].toFixed(3)} bar` : '') +
        `<br>Gradient ${gf.toFixed(0)} %`;
      tip.style.display = 'block';
      const contRect = container.getBoundingClientRect();
      tip.style.left = Math.min(ev.clientX - contRect.left + 14, contRect.width - tip.offsetWidth - 8) + 'px';
      tip.style.top = (ev.clientY - contRect.top - tip.offsetHeight - 10) + 'px';
      g.setAttribute('opacity', '0.85');
    });
    hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; g.removeAttribute('opacity'); });
  }

  // ambient equilibrium reference line
  const eq = (ambientP - 0.0627) * 0.7808;
  el('line', { x1: x(eq), x2: x(eq), y1: pad.top - 6, y2: H - pad.bottom, stroke: INK.secondary, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, svg);
  const eqLbl = el('text', { x: x(eq), y: pad.top - 10, 'text-anchor': 'middle', class: 'ref-label' }, svg);
  eqLbl.textContent = 'air equilibrium';

  // legend
  const lg = el('g', { transform: `translate(${pad.left}, ${12})` }, svg);
  el('rect', { x: 0, y: -8, width: 12, height: 12, rx: 3, fill: SERIES.n2 }, lg);
  const l1 = el('text', { x: 18, y: 2, class: 'legend-label' }, lg); l1.textContent = 'N₂';
  if (hasHe) {
    el('rect', { x: 54, y: -8, width: 12, height: 12, rx: 3, fill: SERIES.he }, lg);
    const l2 = el('text', { x: 72, y: 2, class: 'legend-label' }, lg); l2.textContent = 'He';
  }
}

/* ------------------------------------------------------------------ */
/* Compact saturation meter (dashboard): single bar of surfacing GF    */
/* ------------------------------------------------------------------ */

export function renderGFMeter(container, gfPercent) {
  container.innerHTML = '';
  const pct = Math.max(0, Math.min(140, gfPercent));
  const wrap = document.createElement('div');
  wrap.className = 'gf-meter';
  const status = pct < 60 ? 'ok' : pct < 90 ? 'warn' : 'high';
  wrap.innerHTML = `
    <div class="gf-meter-track">
      <div class="gf-meter-fill gf-${status}" style="width:${Math.min(100, (pct / 140) * 100)}%"></div>
      <div class="gf-meter-100" style="left:${(100 / 140) * 100}%"></div>
    </div>
    <div class="gf-meter-caption">
      <span>Surfacing gradient</span><span class="gf-value">${gfPercent.toFixed(0)} %</span>
    </div>`;
  container.appendChild(wrap);
}
