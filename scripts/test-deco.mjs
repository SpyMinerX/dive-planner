/*
 * test-deco.mjs — sanity checks for the ZH-L16C engine.
 * Run: node scripts/test-deco.mjs
 */
import { Tissues, makeGas, planDive, computeNDL, surfaceInterval, mod, replayProfile } from '../js/deco.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const air = makeGas(0.21, 0, 'Air');
const ean32 = makeGas(0.32, 0, 'EAN32');
const ean50 = { ...makeGas(0.50, 0, 'EAN50'), use: 'deco', switchDepth: 21 };
const tmx1845 = makeGas(0.18, 0.45, 'Tx 18/45');

// 1. clean tissues are surfaceable, GF ~ 0
const clean = new Tissues();
check('clean tissues: ceiling(gf=1) <= 0', clean.ceiling(1) <= 0, `ceiling=${clean.ceiling(1).toFixed(2)}`);
check('clean tissues: surfacing GF = 0', clean.surfacingGF() === 0);

// 2. NDL plausibility (Buhlmann raw NDLs: ~30 m air ≈ 14–20 min incl. descent)
const ndl30 = computeNDL(30, air, 1.0, null);
check('NDL 30 m air, GF100 in 12–22 min', ndl30 >= 12 && ndl30 <= 22, `${ndl30} min`);
const ndl30gf = computeNDL(30, air, 0.75, null);
check('lower GFhigh shortens NDL', ndl30gf < ndl30, `${ndl30gf} < ${ndl30}`);
const ndl18 = computeNDL(18, air, 1.0, null);
check('NDL 18 m air, GF100 in 40–80 min', ndl18 >= 40 && ndl18 <= 80, `${ndl18} min`);
const ndl30n = computeNDL(30, ean32, 1.0, null);
check('nitrox extends NDL', ndl30n > ndl30, `${ndl30n} > ${ndl30}`);

// 3. deco dive: 40 m / 25 min on air, GF 35/75
const plan1 = planDive({ segments: [{ depth: 40, time: 25 }], gases: [{ ...air, use: 'bottom' }], gfLow: 0.35, gfHigh: 0.75 });
check('40m/25min air is a deco dive', plan1.isDecoDive, `first stop ${plan1.firstStop} m`);
check('first stop between 6 and 18 m', plan1.firstStop >= 6 && plan1.firstStop <= 18, `${plan1.firstStop} m`);
check('TTS in a plausible band (10–45 min)', plan1.tts >= 10 && plan1.tts <= 45, `${plan1.tts.toFixed(1)} min`);
check('surfacing GF <= GFhigh (+2% tolerance)', plan1.surfacingGF <= 77, `${plan1.surfacingGF.toFixed(1)} %`);
check('plan ends at surface', plan1.profile[plan1.profile.length - 1].depth === 0);
const stops = plan1.schedule.filter(s => s.type === 'stop');
check('stops get monotonically shallower', stops.every((s, i) => i === 0 || s.to < stops[i - 1].to));
check('deepest stop >= shallowest ceiling seen there', stops.every(s => s.to >= 0));

// 4. richer bottom gas reduces deco
const plan2 = planDive({ segments: [{ depth: 40, time: 25 }], gases: [{ ...ean32, use: 'bottom' }], gfLow: 0.35, gfHigh: 0.75 });
check('EAN32 shortens TTS vs air', plan2.tts < plan1.tts, `${plan2.tts.toFixed(1)} < ${plan1.tts.toFixed(1)}`);

// 5. deco gas shortens the schedule
const plan3 = planDive({ segments: [{ depth: 40, time: 25 }], gases: [{ ...air, use: 'bottom' }, ean50], gfLow: 0.35, gfHigh: 0.75 });
check('EAN50 @21m shortens TTS vs air-only', plan3.tts < plan1.tts, `${plan3.tts.toFixed(1)} < ${plan1.tts.toFixed(1)}`);
check('plan includes a gas switch', plan3.schedule.some(s => s.type === 'switch'));
const swEvt = plan3.schedule.find(s => s.type === 'switch');
check('switch happens at/below 21 m', swEvt.from <= 21 + 1e-6, `${swEvt.from} m`);

// 6. trimix at 60 m
const plan4 = planDive({
  segments: [{ depth: 60, time: 20 }],
  gases: [{ ...tmx1845, use: 'bottom' }, ean50, { ...makeGas(1.0, 0, 'O2'), use: 'deco', switchDepth: 6 }],
  gfLow: 0.30, gfHigh: 0.70,
});
check('60m trimix plan converges', plan4.profile[plan4.profile.length - 1].depth === 0 && !plan4.warnings.some(w => w.text.includes('converge')));
check('60m trimix has helium in tissues at depth', plan4.tissuesAtBottom.pHe.some(p => p > 0.5));
check('trimix ppO2 at 60 m ok (1.26 bar)', !plan4.warnings.some(w => w.text.includes('MOD')));

// 7. hypoxic + MOD warnings fire
const plan5 = planDive({ segments: [{ depth: 45, time: 10 }], gases: [{ ...ean50, use: 'bottom', switchDepth: null }], gfLow: 0.35, gfHigh: 0.75 });
check('MOD violation warning fires (EAN50 @45m)', plan5.warnings.some(w => w.level === 'critical'));

// 8. repetitive dive: residual loading shortens NDL / lengthens deco
const after1 = surfaceInterval(plan1.tissuesEnd, 10);
const ndlRep = computeNDL(30, air, 1.0, after1);
check('residual loading shortens NDL (10 min SI)', ndlRep < ndl30, `${ndlRep} < ${ndl30}`);
check('surface interval off-gasses', after1.surfacingGF() < plan1.tissuesEnd.surfacingGF(),
  `${after1.surfacingGF().toFixed(1)} < ${plan1.tissuesEnd.surfacingGF().toFixed(1)}`);
const longSI = surfaceInterval(plan1.tissuesEnd, 48 * 60);
check('48 h fully desaturates', longSI.surfacingGF() < 1, `${longSI.surfacingGF().toFixed(2)} %`);

// 9. replay of a recorded square profile
const samples = [
  { t: 0, depth: 0, gas: air }, { t: 2, depth: 30, gas: air },
  { t: 20, depth: 30, gas: air }, { t: 24, depth: 0, gas: air },
];
const rep = replayProfile(samples);
check('replay: max depth 30', rep.maxDepth === 30);
check('replay: tissues loaded above clean', rep.tissues.pN2[0] > clean.pN2[0]);
check('replay: maxGF tracked', rep.maxGF > 0 && rep.maxGF < 120, `${rep.maxGF.toFixed(0)} %`);

// 10. MOD helper
check('MOD EAN32 @1.4 ≈ 33.6 m', Math.abs(mod(ean32, 1.4) - 33.6) < 0.5, mod(ean32, 1.4).toFixed(1));
check('MOD O2 @1.6 ≈ 6 m', Math.abs(mod(makeGas(1.0), 1.6) - 5.9) < 0.5, mod(makeGas(1.0), 1.6).toFixed(1));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
