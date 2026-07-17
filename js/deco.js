/*
 * deco.js — Bühlmann ZH-L16C decompression model with Gradient Factors.
 *
 * Units: depth in metres of seawater (1 msw = 0.1 bar), pressure in bar,
 * time in minutes. All tissue maths uses inspired inert-gas pressures
 * (alveolar water vapour subtracted).
 *
 * THIS CODE IS FOR EDUCATION / SIMULATION ONLY — never dive a schedule
 * produced by software that has not been formally validated.
 */

export const SURFACE_PRESSURE = 1.01325; // bar, default at sea level
export const WATER_VAPOUR = 0.0627;      // bar, alveolar water vapour (Buhlmann)
export const FN2_AIR = 0.7808;

// ZH-L16C coefficients — 16 compartments.
export const ZHL16C = {
  n2: {
    halfTime: [5.0, 8.0, 12.5, 18.5, 27.0, 38.3, 54.3, 77.0, 109.0, 146.0, 187.0, 239.0, 305.0, 390.0, 498.0, 635.0],
    a: [1.1696, 1.0000, 0.8618, 0.7562, 0.6200, 0.5043, 0.4410, 0.4000, 0.3750, 0.3500, 0.3295, 0.3065, 0.2835, 0.2610, 0.2480, 0.2327],
    b: [0.5578, 0.6514, 0.7222, 0.7825, 0.8126, 0.8434, 0.8693, 0.8910, 0.9092, 0.9222, 0.9319, 0.9403, 0.9477, 0.9544, 0.9602, 0.9653],
  },
  he: {
    halfTime: [1.88, 3.02, 4.72, 6.99, 10.21, 14.48, 20.53, 29.11, 41.20, 55.19, 70.69, 90.34, 115.29, 147.42, 188.24, 240.03],
    a: [1.6189, 1.3830, 1.1919, 1.0458, 0.9220, 0.8205, 0.7305, 0.6502, 0.5950, 0.5545, 0.5333, 0.5189, 0.5181, 0.5176, 0.5172, 0.5119],
    b: [0.4770, 0.5747, 0.6527, 0.7223, 0.7582, 0.7957, 0.8279, 0.8553, 0.8757, 0.8903, 0.8997, 0.9073, 0.9122, 0.9171, 0.9217, 0.9267],
  },
};

export const NC = 16; // compartment count
const LN2 = Math.LN2;

export function depthToPressure(depth, surfaceP = SURFACE_PRESSURE) {
  return surfaceP + depth / 10;
}
export function pressureToDepth(p, surfaceP = SURFACE_PRESSURE) {
  return Math.max(0, (p - surfaceP) * 10);
}

/** Gas mix. o2/he are fractions (0..1). */
export function makeGas(o2, he = 0, name = null) {
  const n2 = Math.max(0, 1 - o2 - he);
  return { o2, he, n2, name: name || gasName(o2, he) };
}

export function gasName(o2, he = 0) {
  const o2pc = Math.round(o2 * 100);
  const hepc = Math.round(he * 100);
  if (hepc > 0) return `Tx ${o2pc}/${hepc}`;
  if (o2pc === 21) return 'Air';
  if (o2pc === 100) return 'O₂ 100%';
  return `EAN${o2pc}`;
}

/** Maximum operating depth for a ppO2 limit (bar). */
export function mod(gas, ppO2Max = 1.4, surfaceP = SURFACE_PRESSURE) {
  return pressureToDepth(ppO2Max / gas.o2, surfaceP);
}

/** Equivalent narcotic depth (O2 counted narcotic). */
export function end(depth, gas, surfaceP = SURFACE_PRESSURE) {
  const p = depthToPressure(depth, surfaceP);
  return pressureToDepth(p * (1 - gas.he), surfaceP);
}

/* ------------------------------------------------------------------ */
/* Tissue state                                                        */
/* ------------------------------------------------------------------ */

export class Tissues {
  constructor(surfaceP = SURFACE_PRESSURE) {
    this.surfaceP = surfaceP;
    this.pN2 = new Array(NC).fill((surfaceP - WATER_VAPOUR) * FN2_AIR);
    this.pHe = new Array(NC).fill(0);
  }

  clone() {
    const t = new Tissues(this.surfaceP);
    t.pN2 = this.pN2.slice();
    t.pHe = this.pHe.slice();
    return t;
  }

  static fromArrays(pN2, pHe, surfaceP = SURFACE_PRESSURE) {
    const t = new Tissues(surfaceP);
    t.pN2 = pN2.slice();
    t.pHe = pHe.slice();
    return t;
  }

  /** Exposure at constant ambient pressure for tMin minutes. */
  loadConstant(ambientP, gas, tMin) {
    if (tMin <= 0) return;
    const piN2 = Math.max(0, (ambientP - WATER_VAPOUR) * gas.n2);
    const piHe = Math.max(0, (ambientP - WATER_VAPOUR) * gas.he);
    for (let i = 0; i < NC; i++) {
      this.pN2[i] += (piN2 - this.pN2[i]) * (1 - Math.pow(2, -tMin / ZHL16C.n2.halfTime[i]));
      this.pHe[i] += (piHe - this.pHe[i]) * (1 - Math.pow(2, -tMin / ZHL16C.he.halfTime[i]));
    }
  }

  /** Linear pressure change (Schreiner) from startP to endP over tMin minutes. */
  loadRamp(startP, endP, gas, tMin) {
    if (tMin <= 0) return;
    const rate = (endP - startP) / tMin; // bar/min ambient
    const piN2 = Math.max(0, (startP - WATER_VAPOUR) * gas.n2);
    const piHe = Math.max(0, (startP - WATER_VAPOUR) * gas.he);
    const rN2 = rate * gas.n2;
    const rHe = rate * gas.he;
    for (let i = 0; i < NC; i++) {
      const kN2 = LN2 / ZHL16C.n2.halfTime[i];
      const kHe = LN2 / ZHL16C.he.halfTime[i];
      this.pN2[i] = piN2 + rN2 * (tMin - 1 / kN2) - (piN2 - this.pN2[i] - rN2 / kN2) * Math.exp(-kN2 * tMin);
      this.pHe[i] = piHe + rHe * (tMin - 1 / kHe) - (piHe - this.pHe[i] - rHe / kHe) * Math.exp(-kHe * tMin);
    }
  }

  /** Tolerated ambient pressure (bar) for compartment i at gradient factor gf. */
  toleratedAmbient(i, gf) {
    const pt = this.pN2[i] + this.pHe[i];
    if (pt <= 0) return 0;
    const a = (ZHL16C.n2.a[i] * this.pN2[i] + ZHL16C.he.a[i] * this.pHe[i]) / pt;
    const b = (ZHL16C.n2.b[i] * this.pN2[i] + ZHL16C.he.b[i] * this.pHe[i]) / pt;
    return (pt - a * gf) / (gf / b + 1 - gf);
  }

  /** Ceiling depth in metres for a given gradient factor (0 = surface OK). */
  ceiling(gf) {
    let maxP = 0;
    for (let i = 0; i < NC; i++) maxP = Math.max(maxP, this.toleratedAmbient(i, gf));
    return pressureToDepth(maxP, this.surfaceP);
  }

  /**
   * Current gradient (% of Buhlmann M-value overpressure) at ambient pressure.
   * ~"GF99". 0% = at or below equilibrium line, 100% = raw M-value.
   */
  currentGF(ambientP) {
    let maxGF = 0;
    for (let i = 0; i < NC; i++) maxGF = Math.max(maxGF, this.compartmentGF(i, ambientP));
    return maxGF;
  }

  compartmentGF(i, ambientP) {
    const pt = this.pN2[i] + this.pHe[i];
    if (pt <= 0) return 0;
    const a = (ZHL16C.n2.a[i] * this.pN2[i] + ZHL16C.he.a[i] * this.pHe[i]) / pt;
    const b = (ZHL16C.n2.b[i] * this.pN2[i] + ZHL16C.he.b[i] * this.pHe[i]) / pt;
    const mValue = ambientP / b + a; // tolerated tissue pressure at gf=1
    const grad = pt - ambientP;
    const maxGrad = mValue - ambientP;
    if (maxGrad <= 0) return 0;
    return Math.max(0, (grad / maxGrad) * 100);
  }

  /** GF on surfacing right now. */
  surfacingGF() {
    return this.currentGF(this.surfaceP);
  }

  /** No-decompression limit check: can we ascend directly to the surface at gfHigh? */
  canSurface(gfHigh) {
    return this.ceiling(gfHigh) <= 0;
  }

  toJSON() {
    return { pN2: this.pN2, pHe: this.pHe, surfaceP: this.surfaceP };
  }

  static fromJSON(o) {
    if (!o || !Array.isArray(o.pN2)) return new Tissues();
    return Tissues.fromArrays(o.pN2, o.pHe || new Array(NC).fill(0), o.surfaceP || SURFACE_PRESSURE);
  }
}

/* ------------------------------------------------------------------ */
/* Oxygen toxicity                                                     */
/* ------------------------------------------------------------------ */

// NOAA single-exposure CNS limits (minutes at ppO2) — linear interpolation.
const CNS_TABLE = [
  [0.5, Infinity], [0.6, 720], [0.7, 570], [0.8, 450], [0.9, 360],
  [1.0, 300], [1.1, 240], [1.2, 210], [1.3, 180], [1.4, 150],
  [1.5, 120], [1.6, 45], [1.7, 30], [1.8, 22], [1.9, 15], [2.0, 10],
];

export function cnsRate(ppO2) {
  if (ppO2 <= 0.5) return 0;
  const capped = Math.min(ppO2, 2.0);
  for (let i = 1; i < CNS_TABLE.length; i++) {
    if (capped <= CNS_TABLE[i][0]) {
      const [p0, t0] = CNS_TABLE[i - 1];
      const [p1, t1] = CNS_TABLE[i];
      const limit = t0 === Infinity ? t1 : t0 + (t1 - t0) * (capped - p0) / (p1 - p0);
      return 100 / limit; // % per minute
    }
  }
  return 100 / 10;
}

export function otuRate(ppO2) {
  if (ppO2 <= 0.5) return 0;
  return Math.pow((ppO2 - 0.5) / 0.5, 0.83);
}

/* ------------------------------------------------------------------ */
/* Dive planner                                                        */
/* ------------------------------------------------------------------ */

/**
 * Plan a dive.
 * @param {object} opts
 *   segments:    [{ depth, time }]  planned levels; each segment's time includes travel to it
 *   gases:       [{ o2, he, switchDepth|null, use: 'bottom'|'deco' }]
 *   gfLow/gfHigh: gradient factors as fractions (e.g. 0.35 / 0.75)
 *   startTissues: Tissues instance (residual loading) or null for clean
 *   surfaceP, descentRate, ascentRate, lastStopDepth, sacBottom, sacDeco
 * @returns plan { schedule, profile, tissuesEnd, warnings, tts, runtime, cns, otu, gasUsage, ndl, firstStop }
 */
export function planDive(opts) {
  const {
    segments,
    gases,
    gfLow = 0.35,
    gfHigh = 0.75,
    surfaceP = SURFACE_PRESSURE,
    descentRate = 18,
    ascentRate = 9,
    lastStopDepth = 3,
    sacBottom = 20,
    sacDeco = 16,
    startTissues = null,
    ppO2MaxBottom = 1.4,
    ppO2MaxDeco = 1.6,
  } = opts;

  const tissues = startTissues ? startTissues.clone() : new Tissues(surfaceP);
  tissues.surfaceP = surfaceP;
  const warnings = [];
  const schedule = [];
  const profile = []; // {t, depth, gasIdx, ceiling}
  let cns = 0, otu = 0;
  const gasUsage = gases.map(() => 0);

  const bottomGases = gases.filter(g => g.use !== 'deco');
  const bottomGas = bottomGases[0] || gases[0];
  if (!bottomGas) throw new Error('At least one gas is required');
  const decoGases = gases
    .filter(g => g.use === 'deco' && g.switchDepth != null)
    .sort((a, b) => b.switchDepth - a.switchDepth);

  let t = 0;
  let depth = 0;
  let gas = bottomGas;

  const pAt = d => depthToPressure(d, surfaceP);

  function trackTox(d, g, minutes) {
    const ppO2 = pAt(d) * g.o2;
    cns += cnsRate(ppO2) * minutes;
    otu += otuRate(ppO2) * minutes;
  }
  function trackGas(dFrom, dTo, g, minutes, sac) {
    const avgP = (pAt(dFrom) + pAt(dTo)) / 2;
    const idx = gases.indexOf(g);
    if (idx >= 0) gasUsage[idx] += sac * avgP * minutes;
  }
  function sample() {
    profile.push({ t, depth, gas, ceiling: Math.max(0, tissues.ceiling(gfCurrent(depth))) });
  }

  let firstStopDepth = null;
  function gfCurrent(d) {
    if (firstStopDepth == null || firstStopDepth <= 0) return gfHigh;
    if (d >= firstStopDepth) return gfLow;
    return gfHigh + (gfLow - gfHigh) * (d / firstStopDepth);
  }

  // --- NDL at the first segment depth on bottom gas (informational) ---
  const ndl = computeNDL(segments[0].depth, bottomGas, gfHigh, startTissues, surfaceP, descentRate);

  sample();

  // --- Bottom phase: travel + level for each segment ---
  for (const seg of segments) {
    const travel = Math.abs(seg.depth - depth) / (seg.depth > depth ? descentRate : ascentRate);
    if (travel > 0) {
      tissues.loadRamp(pAt(depth), pAt(seg.depth), gas, travel);
      trackTox((depth + seg.depth) / 2, gas, travel);
      trackGas(depth, seg.depth, gas, travel, sacBottom);
      t += travel;
      const from = depth;
      depth = seg.depth;
      schedule.push({ type: seg.depth > from ? 'descent' : 'level-change', from, to: depth, duration: travel, runtime: t, gas });
      sample();
    }
    const levelTime = Math.max(0, seg.time - travel);
    if (levelTime > 0) {
      // integrate in 1-min slices so the profile chart gets points
      let remaining = levelTime;
      while (remaining > 0) {
        const dt = Math.min(1, remaining);
        tissues.loadConstant(pAt(depth), gas, dt);
        trackTox(depth, gas, dt);
        trackGas(depth, depth, gas, dt, sacBottom);
        t += dt; remaining -= dt;
        sample();
      }
      schedule.push({ type: 'bottom', from: depth, to: depth, duration: levelTime, runtime: t, gas });
    }
    const ppO2 = pAt(seg.depth) * gas.o2;
    if (ppO2 > ppO2MaxBottom + 1e-9) {
      warnings.push({ level: 'critical', text: `ppO₂ ${ppO2.toFixed(2)} bar on ${gas.name} at ${seg.depth} m exceeds ${ppO2MaxBottom} bar (MOD ${mod(gas, ppO2MaxBottom, surfaceP).toFixed(0)} m)` });
    }
    const endDepth = end(seg.depth, gas, surfaceP);
    if (endDepth > 40) warnings.push({ level: 'warning', text: `END ${endDepth.toFixed(0)} m at ${seg.depth} m — significant narcosis load` });
  }
  if (pAt(0) * bottomGas.o2 < 0.16) {
    warnings.push({ level: 'critical', text: `${bottomGas.name} is hypoxic at the surface (ppO₂ ${(pAt(0) * bottomGas.o2).toFixed(2)} bar)` });
  }

  // --- Ascent phase ---
  const bottomTissues = tissues.clone();

  // Determine first stop with gfLow
  const rawCeiling = tissues.ceiling(gfLow);
  firstStopDepth = rawCeiling <= 0 ? 0 : Math.max(lastStopDepth, Math.ceil(rawCeiling / 3) * 3);

  function maybeSwitchGas(d) {
    for (const g of decoGases) {
      if (g !== gas && d <= g.switchDepth + 1e-9 && gases.indexOf(g) > gases.indexOf(gas)) {
        // only switch "up" to richer mixes as we ascend
        if (g.o2 > gas.o2 || g.he < gas.he) {
          gas = g;
          schedule.push({ type: 'switch', from: d, to: d, duration: 0, runtime: t, gas });
          const ppO2 = pAt(d) * g.o2;
          if (ppO2 > ppO2MaxDeco + 1e-9) warnings.push({ level: 'critical', text: `Deco switch to ${g.name} at ${d} m gives ppO₂ ${ppO2.toFixed(2)} bar (> ${ppO2MaxDeco})` });
          return true;
        }
      }
    }
    return false;
  }

  function ascendTo(target) {
    const dur = (depth - target) / ascentRate;
    if (dur <= 0) { depth = target; return; }
    tissues.loadRamp(pAt(depth), pAt(target), gas, dur);
    trackTox((depth + target) / 2, gas, dur);
    trackGas(depth, target, gas, dur, sacDeco);
    t += dur;
    const from = depth;
    depth = target;
    schedule.push({ type: 'ascent', from, to: target, duration: dur, runtime: t, gas });
    sample();
  }

  let guard = 0;
  while (depth > 0) {
    if (++guard > 2000) { warnings.push({ level: 'critical', text: 'Planner aborted: schedule did not converge' }); break; }

    // Next stop candidate: the deeper of (ceiling rounded to 3 m) and last stop
    const ceilNow = tissues.ceiling(gfCurrent(depth));
    let nextStop = ceilNow <= 0 ? 0 : Math.max(lastStopDepth, Math.ceil(ceilNow / 3) * 3);
    if (firstStopDepth > 0 && nextStop > 0 && nextStop < lastStopDepth) nextStop = lastStopDepth;

    // Force a pause at gas-switch depths on the way up
    let target = nextStop;
    for (const g of decoGases) {
      if (g.switchDepth < depth - 1e-9 && g.switchDepth > target + 1e-9 && gases.indexOf(g) > gases.indexOf(gas) && g.o2 > gas.o2) {
        target = Math.ceil(g.switchDepth / 3) * 3 <= depth ? g.switchDepth : target;
      }
    }

    if (target >= depth - 1e-9) {
      // Can't ascend — hold as a deco stop at current depth in 1-min steps
      const stopDepth = depth;
      let stopTime = 0;
      maybeSwitchGas(stopDepth);
      let innerGuard = 0;
      while (innerGuard++ < 999) {
        const next = Math.max(0, stopDepth - 3 < lastStopDepth ? 0 : stopDepth - 3);
        const gfAtNext = gfCurrent(next);
        const trial = tissues.clone();
        const ascDur = (stopDepth - next) / ascentRate;
        trial.loadRamp(pAt(stopDepth), pAt(next), gas, ascDur);
        if (trial.ceiling(gfAtNext) <= next + 1e-6) break;
        tissues.loadConstant(pAt(stopDepth), gas, 1);
        trackTox(stopDepth, gas, 1);
        trackGas(stopDepth, stopDepth, gas, 1, sacDeco);
        t += 1; stopTime += 1;
        sample();
      }
      if (stopTime > 0) schedule.push({ type: 'stop', from: stopDepth, to: stopDepth, duration: stopTime, runtime: t, gas });
      const next = Math.max(0, stopDepth - 3 < lastStopDepth ? 0 : stopDepth - 3);
      ascendTo(next);
      maybeSwitchGas(depth);
    } else {
      ascendTo(target);
      maybeSwitchGas(depth);
    }
  }

  sample();

  const bottomRuntime = segments.reduce((s, x) => s + x.time, 0);
  const tts = t - bottomRuntime;
  const surfGF = tissues.surfacingGF();

  if (cns >= 80) warnings.push({ level: cns >= 100 ? 'critical' : 'warning', text: `CNS oxygen clock at ${cns.toFixed(0)} %` });
  if (firstStopDepth === 0) {
    // no-deco dive
  }

  return {
    schedule, profile, warnings,
    tissuesEnd: tissues,
    tissuesAtBottom: bottomTissues,
    runtime: t,
    tts,
    ndl,
    cns, otu,
    gasUsage,
    firstStop: firstStopDepth,
    surfacingGF: surfGF,
    isDecoDive: firstStopDepth > 0,
  };
}

/** Max minutes at depth (incl. descent) before a direct ascent violates gfHigh. */
export function computeNDL(depth, gas, gfHigh, startTissues, surfaceP = SURFACE_PRESSURE, descentRate = 18, ascentRate = 9) {
  const tis = startTissues ? startTissues.clone() : new Tissues(surfaceP);
  tis.surfaceP = surfaceP;
  const pBottom = depthToPressure(depth, surfaceP);
  const descent = depth / descentRate;
  tis.loadRamp(depthToPressure(0, surfaceP), pBottom, gas, descent);
  const ascDur = depth / ascentRate;

  const surfacable = tt => {
    const trial = tt.clone();
    trial.loadRamp(pBottom, depthToPressure(0, surfaceP), gas, ascDur);
    return trial.ceiling(gfHigh) <= 0;
  };

  if (!surfacable(tis)) return 0;
  let minutes = 0;
  while (minutes < 999) {
    const trial = tis.clone();
    trial.loadConstant(pBottom, gas, 1);
    if (!surfacable(trial)) break;
    tis.loadConstant(pBottom, gas, 1);
    minutes += 1;
  }
  return Math.round(descent + minutes);
}

/** Off-gas tissues at the surface breathing air for `minutes`. */
export function surfaceInterval(tissues, minutes, surfaceP = SURFACE_PRESSURE) {
  const t = tissues.clone();
  t.loadConstant(surfaceP, makeGas(0.2095, 0, 'Air'), minutes);
  return t;
}

/**
 * Replay a recorded dive profile (list of {t: minutes, depth: m, gas}) through
 * the model. Returns { tissues, maxDepth, duration, cns, otu, maxGF, profile }.
 */
export function replayProfile(samples, startTissues = null, surfaceP = SURFACE_PRESSURE) {
  const tissues = startTissues ? startTissues.clone() : new Tissues(surfaceP);
  tissues.surfaceP = surfaceP;
  let cns = 0, otu = 0, maxDepth = 0, maxGF = 0;
  const profile = [];
  if (!samples.length) return { tissues, maxDepth: 0, duration: 0, cns, otu, maxGF, profile };

  let prev = { t: 0, depth: 0, gas: samples[0].gas || makeGas(0.21) };
  for (const s of samples) {
    const gas = s.gas || prev.gas;
    const dt = s.t - prev.t;
    if (dt > 0) {
      tissues.loadRamp(depthToPressure(prev.depth, surfaceP), depthToPressure(s.depth, surfaceP), gas, dt);
      const midD = (prev.depth + s.depth) / 2;
      const ppO2 = depthToPressure(midD, surfaceP) * gas.o2;
      cns += cnsRate(ppO2) * dt;
      otu += otuRate(ppO2) * dt;
    }
    maxDepth = Math.max(maxDepth, s.depth);
    const gfNow = tissues.currentGF(depthToPressure(s.depth, surfaceP));
    maxGF = Math.max(maxGF, gfNow);
    profile.push({ t: s.t, depth: s.depth, gas, ceiling: Math.max(0, tissues.ceiling(1)), gf: gfNow });
    prev = { t: s.t, depth: s.depth, gas };
  }
  return { tissues, maxDepth, duration: prev.t, cns, otu, maxGF, profile };
}
