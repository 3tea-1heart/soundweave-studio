/**
 * 音色客观测试：预设参数审计 + 渲染分析。
 * 用法：node tools/sound-tests.mjs
 *
 * 直接实例化 AudioWorklet 使用的同一个 StudioProcessor，逐 block 渲染并分析：
 * 力度单调、多个稳定音高的音准、释音衰减、踩镲互斥、声像分离、极端参数无 NaN，
 * 以及 64 个预设是否都能发出可听声音。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioProcessor, defaultParams } from '../src/audio/studio-processor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SR = 48000;
const BPM = 96;
const BEAT = 60 / BPM;

globalThis.sampleRate = SR;

async function loadTs(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(url);
}

const { PARAM_DEFS } = await loadTs(join(ROOT, 'src/core/instrument-defaults.ts'));
const { PRESETS, PRESET_CATEGORIES, auditionNotes, auditionMinLength, presetTrackFx } = await loadTs(join(ROOT, 'src/core/presets.ts'));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- 渲染工具
function createStudio(defs) {
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.postMessage = () => {};
  defs.forEach((def, i) => {
    sp.receive({
      type: 'track',
      track: i,
      instrumentType: def.type,
      params: Object.assign(defaultParams(def.type), def.params || {}),
      volume: def.volume ?? 0.9,
      pan: def.pan ?? 0,
      sendReverb: def.sendReverb ?? 0,
      sendDelay: def.sendDelay ?? 0,
      tone: def.tone ?? 0.9,
      drive: def.drive ?? 0,
      chorus: def.chorus ?? 0,
    });
  });
  sp.receive({ type: 'master', volume: 1 });
  return sp;
}

function addNote(sp, track, pitch, whenSec, durSec, velocity = 0.7, art = 'normal') {
  sp.receive({
    type: 'note', track, pitch, velocity,
    when: whenSec, dur: durSec,
    id: `n_${track}_${pitch}_${whenSec}`,
    art,
  });
}

function render(sp, seconds) {
  const total = Math.floor(seconds * SR);
  const frames = Math.ceil(total / 128);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const blockL = new Float32Array(128);
  const blockR = new Float32Array(128);
  for (let b = 0; b < frames; b++) {
    blockL.fill(0);
    blockR.fill(0);
    sp.processBlock([blockL, blockR]);
    const start = b * 128;
    const count = Math.min(128, total - start);
    for (let i = 0; i < count; i++) {
      L[start + i] = blockL[i];
      R[start + i] = blockR[i];
    }
  }
  return { L, R, sp };
}

function rmsChannel(sig, startSec, endSec) {
  const a = Math.max(0, Math.floor(startSec * SR));
  const b = Math.min(sig.length, Math.floor(endSec * SR));
  let sum = 0;
  for (let i = a; i < b; i++) sum += sig[i] * sig[i];
  return Math.sqrt(sum / Math.max(1, b - a));
}

function rmsRange(L, R, startSec, endSec) {
  return Math.sqrt(
    (rmsChannel(L, startSec, endSec) ** 2 + rmsChannel(R, startSec, endSec) ** 2) / 2,
  );
}

function scan(L, R) {
  let peak = 0;
  let nonFinite = 0;
  let over = 0;
  let sum = 0;
  for (let i = 0; i < L.length; i++) {
    for (const v of [L[i], R[i]]) {
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > 1) over++;
      sum += v * v;
    }
  }
  return { peak, nonFinite, over, rms: Math.sqrt(sum / Math.max(1, L.length * 2)) };
}

/**
 * 基频估计：Hann 窗 DFT + 抛物线插值。
 * 比原始实现的整数 Hz 峰值更细，足以支撑 ±10–15 cents 的判定。
 */
function estimatePitch(sig, startSec, winSec, fMin = 40, fMax = 1200) {
  const start = Math.max(0, Math.floor(startSec * SR));
  const N = Math.min(Math.floor(winSec * SR), sig.length - start);
  if (N < 256) return 0;
  const x = new Float32Array(N);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += sig[start + i];
  mean /= N;
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    x[i] = (sig[start + i] - mean) * w;
  }
  const mags = [];
  for (let f = fMin; f <= fMax; f += 1) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < N; i += 2) {
      re += x[i] * Math.cos(w * i);
      im += x[i] * Math.sin(w * i);
    }
    mags.push(re * re + im * im);
  }
  let best = 1;
  for (let k = 2; k < mags.length - 1; k++) if (mags[k] > mags[best]) best = k;
  const m0 = mags[best - 1];
  const m1 = mags[best];
  const m2 = mags[best + 1];
  const den = m0 - 2 * m1 + m2;
  let delta = Math.abs(den) > 1e-12 ? (0.5 * (m0 - m2)) / den : 0;
  delta = Math.max(-0.5, Math.min(0.5, delta));
  return fMin + (best + delta);
}

function mtof(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function centsError(actual, expected) {
  return 1200 * Math.log2(actual / expected);
}

// ---------------------------------------------------------------- 1. 预设审计
console.log('— 预设参数审计 —');
check('预设数量保持 64 个', PRESETS.length === 64, `${PRESETS.length}`);
check('预设 ID 唯一', new Set(PRESETS.map((p) => p.id)).size === PRESETS.length);
const BUILTIN_CATEGORIES = PRESET_CATEGORIES.filter((c) => c !== '我的音色');
check(
  '分类完整',
  PRESET_CATEGORIES.includes('我的音色') &&
    BUILTIN_CATEGORIES.length === 8 &&
    BUILTIN_CATEGORIES.every((c) => PRESETS.some((p) => p.category === c)),
  `${PRESET_CATEGORIES.join('/')}`,
);

const presetViolations = [];
const macroViolations = [];
for (const preset of PRESETS) {
  const defs = PARAM_DEFS[preset.type] || [];
  for (const [key, value] of Object.entries(preset.params)) {
    const def = defs.find((d) => d.key === key);
    if (!def) {
      presetViolations.push(`${preset.id}: 未定义参数 ${key}`);
      continue;
    }
    if (!Number.isFinite(value) || value < def.min - 1e-9 || value > def.max + 1e-9) {
      presetViolations.push(`${preset.id}: ${key}=${value} 超出 [${def.min}, ${def.max}]`);
    }
  }
  for (const macro of preset.macros || []) {
    for (const t of macro.targets) {
      if (t.min > t.max) macroViolations.push(`${preset.id}/${macro.id}: 目标 ${t.param || t.fx} 下限大于上限`);
      if (t.param) {
        const def = defs.find((d) => d.key === t.param);
        if (!def) {
          macroViolations.push(`${preset.id}/${macro.id}: 未定义参数 ${t.param}`);
        } else if (t.min < def.min - 1e-9 || t.max > def.max + 1e-9) {
          macroViolations.push(`${preset.id}/${macro.id}: ${t.param} ${t.min}–${t.max} 超出 [${def.min}, ${def.max}]`);
        }
      } else if (t.fx) {
        const lo = t.fx === 'pan' ? -1 : 0;
        if (t.min < lo - 1e-9 || t.max > 1 + 1e-9) {
          macroViolations.push(`${preset.id}/${macro.id}: ${t.fx} ${t.min}–${t.max} 超出 [${lo}, 1]`);
        }
      } else {
        macroViolations.push(`${preset.id}/${macro.id}: 宏目标既无 param 也无 fx`);
      }
    }
  }
}
check('预设参数均在界面范围内', presetViolations.length === 0, presetViolations.slice(0, 4).join('；'));
check('音色宏目标均在界面范围内', macroViolations.length === 0, macroViolations.slice(0, 4).join('；'));

// ---------------------------------------------------------------- 2. 力度单调
console.log('\n— 力度单调响度 —');
const velocityCases = [
  ['piano', { brightness: 0.6, decay: 1.8, sustain: 0.3, release: 0.4, attack: 0.004 }, 60],
  ['ep', { index: 2.0, tine: 0.45, decay: 1.8, sustain: 0.28, release: 0.4 }, 60],
  ['guitar', { damping: 0.45, bright: 0.55 }, 60],
  ['synth', { wave: 0, cutoff: 3000, resonance: 0.2, detune: 0, sub: 0.1, attack: 0.02, decay: 0.4, sustain: 0.4, release: 0.3, filterEnv: 0.3 }, 60],
];
for (const [type, params, pitch] of velocityCases) {
  const levels = [0.35, 0.6, 0.85];
  const values = [];
  for (const vel of levels) {
    const sp = createStudio([{ type, params }]);
    addNote(sp, 0, pitch, 0, 2.5, vel);
    const { L, R } = render(sp, 1.1);
    values.push(rmsRange(L, R, 0.05, 0.9));
  }
  const mono = values[0] < values[1] && values[1] < values[2];
  const margin = values[1] > values[0] * 1.1 && values[2] > values[1] * 1.05;
  check(`力度单调：${type}`, mono && margin, values.map((v) => v.toFixed(4)).join(' → '));
}

// ---------------------------------------------------------------- 3. 音准
console.log('\n— 多音高音准 —');
const pitchCases = [
  {
    type: 'piano', tol: 10, spacing: 1.5, win: 0.3, offset: 0.15, seconds: 4.5,
    params: { brightness: 0.6, decay: 2.6, sustain: 0.45, release: 0.5, attack: 0.004 },
    pitches: [48, 60, 72],
  },
  {
    type: 'guitar', tol: 15, spacing: 1.5, win: 0.28, offset: 0.12, seconds: 4.5,
    params: { damping: 0.5, bright: 0.6 },
    pitches: [52, 60, 67],
  },
  {
    type: 'synth', tol: 10, spacing: 1.4, win: 0.3, offset: 0.2, seconds: 4.2,
    params: { wave: 0, cutoff: 4000, resonance: 0.1, detune: 0, sub: 0, attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.3, filterEnv: 0, lfoDepth: 0 },
    pitches: [57, 64, 72],
  },
  {
    type: 'bass', tol: 12, spacing: 1.4, win: 0.3, offset: 0.15, seconds: 4.2,
    params: { cutoff: 2000, resonance: 0.1, detune: 0, sub: 0, attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.3, filterEnv: 0, octave: -12 },
    pitches: [48, 52, 57],
  },
];
for (const c of pitchCases) {
  const sp = createStudio([{ type: c.type, params: c.params, tone: 1 }]);
  c.pitches.forEach((pitch, i) => addNote(sp, 0, pitch, i * c.spacing, c.spacing * 0.85, 0.75));
  const { L } = render(sp, c.seconds);
  const octave = c.params.octave || 0;
  c.pitches.forEach((pitch, i) => {
    const expected = mtof(pitch + octave);
    const actual = estimatePitch(L, i * c.spacing + c.offset, c.win);
    const cents = centsError(actual, expected);
    check(
      `音准：${c.type} ${pitch}`,
      Number.isFinite(actual) && Math.abs(cents) <= c.tol,
      `期望 ${expected.toFixed(1)}Hz，实测 ${actual.toFixed(1)}Hz，偏差 ${cents.toFixed(1)} cents`,
    );
  });
}

// ---------------------------------------------------------------- 4. 释音
console.log('\n— 释音 —');
{
  const params = { wave: 0, cutoff: 2000, resonance: 0.1, detune: 0, sub: 0, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.2, filterEnv: 0, lfoDepth: 0 };
  const spShort = createStudio([{ type: 'synth', params, tone: 1 }]);
  addNote(spShort, 0, 60, 0, 0.5, 0.7);
  const short = render(spShort, 1.6);
  const shortEarly = rmsRange(short.L, short.R, 0.2, 0.45);
  const shortLate = rmsRange(short.L, short.R, 0.9, 1.5);

  const spLong = createStudio([{ type: 'synth', params, tone: 1 }]);
  addNote(spLong, 0, 60, 0, 2.2, 0.7);
  const long = render(spLong, 1.6);
  const longLate = rmsRange(long.L, long.R, 0.9, 1.5);

  check('释音：释放后能量显著下降', shortLate < shortEarly * 0.2, `${shortEarly.toFixed(4)} → ${shortLate.toFixed(4)}`);
  check('释音：长音在释放点后仍在发声', longLate > shortLate * 4, `短音 ${shortLate.toFixed(4)} / 长音 ${longLate.toFixed(4)}`);
}

// ---------------------------------------------------------------- 5. 踩镲互斥
console.log('\n— 踩镲互斥 —');
{
  const defs = [{ type: 'drum', params: { punch: 0.6, decay: 0.45, toneShift: 0.5, drive: 0 } }];
  const alone = createStudio(defs);
  addNote(alone, 0, 44, 0, 0.3, 0.8);
  const a = render(alone, 0.3);
  const aloneAlive = a.sp.tracks[0].voices.some((v) => v.piece === 'openhat' && !v.done);
  check('踩镲：单独开镲仍在发声', aloneAlive);

  const stacked = createStudio(defs);
  addNote(stacked, 0, 44, 0, 0.3, 0.8);
  addNote(stacked, 0, 42, 0.25, 0.1, 0.7);
  const b = render(stacked, 0.3);
  const openGone = !b.sp.tracks[0].voices.some((v) => v.piece === 'openhat' && !v.done);
  const hatAlive = b.sp.tracks[0].voices.some((v) => v.piece === 'hat' && !v.done);
  check('踩镲：闭镲触发后开镲被切断', openGone);
  check('踩镲：新闭镲声部仍在发声', hatAlive);
}

// ---------------------------------------------------------------- 6. 声像
console.log('\n— 声像 —');
{
  const params = { wave: 0, cutoff: 2000, resonance: 0.1, detune: 0, sub: 0, attack: 0.02, decay: 0.5, sustain: 0.5, release: 0.4, filterEnv: 0, lfoDepth: 0 };
  for (const pan of [-1, 1]) {
    const sp = createStudio([{ type: 'synth', params, pan, tone: 1 }]);
    addNote(sp, 0, 60, 0, 3.0, 0.7);
    const { L, R } = render(sp, 2.4);
    const l = rmsChannel(L, 0.5, 2.2);
    const r = rmsChannel(R, 0.5, 2.2);
    const quiet = Math.min(l, r);
    const loud = Math.max(l, r);
    check(`声像：pan=${pan} 单侧静音`, quiet < loud * 0.02 && loud > 0.02, `L ${l.toFixed(4)} / R ${r.toFixed(4)}`);
  }
  const sp = createStudio([{ type: 'synth', params, pan: 0, tone: 1 }]);
  addNote(sp, 0, 60, 0, 3.0, 0.7);
  const { L, R } = render(sp, 2.4);
  const l = rmsChannel(L, 0.5, 2.2);
  const r = rmsChannel(R, 0.5, 2.2);
  check('声像：居中时左右平衡', Math.abs(l - r) < Math.max(l, r) * 0.06 && l > 0.01, `L ${l.toFixed(4)} / R ${r.toFixed(4)}`);
}

// ---------------------------------------------------------------- 7. 极端参数 / NaN
console.log('\n— 极端参数稳定性 —');
{
  const stressDefs = [
    { type: 'synth', params: { wave: 1, cutoff: 6000, resonance: 1, drive: 1, detune: 50, sub: 1, attack: 0.001, decay: 0.02, sustain: 1, release: 0.03, filterEnv: 1, lfoRate: 20, lfoDepth: 1, tremolo: 1, pulseWidth: 0.1 }, volume: 1, drive: 1, chorus: 1, sendReverb: 1 },
    { type: 'bass', params: { wave: 1, cutoff: 3000, resonance: 1, drive: 1, detune: 50, sub: 1, attack: 0.001, decay: 0.02, sustain: 1, release: 0.03, filterEnv: 1, lfoRate: 20, lfoDepth: 1, octave: -12 }, volume: 1, drive: 1, chorus: 1, sendReverb: 1 },
    { type: 'ep', params: { index: 5, tine: 1, decay: 4, sustain: 1, release: 0.03, drive: 1, chorus: 1 }, volume: 1, drive: 1, chorus: 1, sendReverb: 1 },
    { type: 'piano', params: { brightness: 1, decay: 0.2, sustain: 1, release: 0.03, drive: 1, chorus: 1 }, volume: 1, drive: 1, chorus: 1, sendReverb: 1 },
    { type: 'guitar', params: { damping: 0.05, bright: 1, drive: 1, chorus: 1 }, volume: 1, drive: 1, chorus: 1, sendReverb: 1 },
    { type: 'drum', params: { punch: 1, decay: 1, toneShift: 1, drive: 1, chorus: 1 }, volume: 1, drive: 1, chorus: 1, sendReverb: 1 },
  ];
  const sp = createStudio(stressDefs);
  stressDefs.forEach((def, t) => {
    for (let i = 0; i < 10; i++) addNote(sp, t, 48 + ((i * 5) % 36), i * 0.08, 0.07, 1);
  });
  const { L, R } = render(sp, 1.2);
  const s = scan(L, R);
  check('极端参数：输出无 NaN/Infinity', s.nonFinite === 0, `${s.nonFinite}`);
  check('极端参数：主输出被限幅在 1 以内', s.over === 0 && s.peak <= 0.95 + 1e-6, `peak ${s.peak.toFixed(3)}, over ${s.over}`);
}

// ---------------------------------------------------------------- 8. 全预设可听性
console.log('\n— 64 预设试听 —');
const silentPresets = [];
const clippedPresets = [];
const attackTooLong = [];
for (const preset of PRESETS) {
  const fx = presetTrackFx(preset.type, preset.params);
  const sp = createStudio([{ type: preset.type, params: preset.params, drive: fx.drive, chorus: fx.chorus }]);
  const attack = preset.params.attack || 0;
  const notes = auditionNotes(preset.type, auditionMinLength(attack));
  for (const n of notes) addNote(sp, 0, n.pitch, n.start * BEAT, n.length * BEAT, n.velocity, n.articulation);
  const seconds = 5.2;
  const { L, R } = render(sp, seconds);
  const s = scan(L, R);
  const heard = s.rms > 0.002 && s.peak > 0.01 && s.nonFinite === 0;
  const longest = notes.reduce((m, n) => Math.max(m, n.length * BEAT), 0);
  if (!heard) silentPresets.push(`${preset.id}(rms=${s.rms.toFixed(4)},peak=${s.peak.toFixed(3)}${s.nonFinite ? `,nan=${s.nonFinite}` : ''})`);
  if (s.over > 0) clippedPresets.push(`${preset.id}(peak=${s.peak.toFixed(3)})`);
  if (attack > longest * 0.9) attackTooLong.push(`${preset.id}(attack=${attack}s, note=${longest.toFixed(2)}s)`);
}
check('全预设试听：64 个预设均能发声', silentPresets.length === 0, silentPresets.slice(0, 6).join('；'));
check('全预设试听：无削波输出', clippedPresets.length === 0, clippedPresets.slice(0, 6).join('；'));
check('全预设试听：试听乐句长度覆盖起音', attackTooLong.length === 0, attackTooLong.slice(0, 6).join('；'));

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
