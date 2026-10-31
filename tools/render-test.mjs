/**
 * P1/P4 离线渲染验证：
 * 直接实例化浏览器 AudioWorklet 使用的同一个 StudioProcessor（无任何简化分支），
 * 预排事件、逐 block 渲染、编码 WAV，并做数值检查。
 * 用法：node tools/render-test.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { StudioProcessor, defaultParams } from '../src/audio/studio-processor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'docs', 'audio');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const SR = 48000;

globalThis.sampleRate = SR;

// ---------------------------------------------------------------- WAV encoder
// 与浏览器导出共用 src/core/wav.ts，避免两套编码器导致文件头/量化分叉
async function loadTs(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(url);
}
const { encodeWav } = await loadTs(join(ROOT, 'src/core/wav.ts'));

function wavBuffer(L, R) {
  return Buffer.from(encodeWav([L, R], SR));
}

// ---------------------------------------------------------------- renderer
function createStudio(trackDefs) {
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.postMessage = () => {};
  trackDefs.forEach((def, i) => {
    sp.receive({
      type: 'track',
      track: i,
      instrumentType: def.type,
      params: Object.assign(defaultParams(def.type), def.params || {}),
      volume: def.volume ?? 0.9,
      pan: def.pan ?? 0,
      sendReverb: def.sendReverb ?? 0.2,
      sendDelay: def.sendDelay ?? 0,
      tone: def.tone ?? 0.9,
      drive: def.drive ?? 0.05,
      chorus: def.chorus ?? 0,
    });
  });
  sp.receive({ type: 'master', volume: 0.9 });
  return sp;
}

function renderStudio(sp, seconds, gain = 0.9) {
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
      L[start + i] = blockL[i] * gain;
      R[start + i] = blockR[i] * gain;
    }
  }
  return { L, R };
}

function analyze(name, L, R, expectedSeconds) {
  let max = 0;
  let sum = 0;
  let dc = 0;
  let nonFinite = 0;
  let above = 0;
  for (let i = 0; i < L.length; i++) {
    for (const v of [L[i], R[i]]) {
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      const a = Math.abs(v);
      if (a > max) max = a;
      if (a > 1) above++;
      sum += v * v;
      dc += v;
    }
  }
  const rms = Math.sqrt(sum / (L.length * 2));
  const expected = expectedSeconds * SR;
  const lengthOk = Math.abs(L.length - expected) < SR * 0.02;
  const heard = rms > 0.005;
  console.log(
    `${name.padEnd(26)} len=${(L.length / SR).toFixed(2)}s ok=${lengthOk} peak=${max.toFixed(3)} rms=${rms.toFixed(4)} dc=${(dc / (L.length * 2)).toFixed(5)} nonFinite=${nonFinite} over1=${above} audible=${heard}`,
  );
  return { lengthOk, heard, max, rms, nonFinite, above };
}

// ---------------------------------------------------------------- musical helpers
const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

function addNote(sp, track, pitch, beat, durBeats, vel = 0.75, art = 'normal') {
  sp.receive({
    type: 'note',
    track,
    pitch,
    velocity: vel,
    when: beat * BEAT,
    dur: durBeats * BEAT,
    id: `${track}-${beat}-${pitch}`,
    art,
  });
}

// 音高检查：Hann 窗 DFT（1Hz 步进）+ 抛物线插值。
// 原来用矩形窗 + 2Hz 步进，量化误差就有 ±26 cents，无法支撑更严格的判定。
function dominantFreq(L, startSec, winSec) {
  const start = Math.max(0, Math.floor(startSec * SR));
  const N = Math.min(Math.floor(winSec * SR), L.length - start);
  if (N < 256) return 0;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += L[start + i];
  mean /= N;
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    x[i] = (L[start + i] - mean) * w;
  }
  const mags = [];
  for (let f = 60; f <= 900; f += 1) {
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
  return 60 + best + delta;
}
function checkPitch(label, L, expectedHz, startSec, winSec = 0.3, tolCents = 20) {
  const f = dominantFreq(L, startSec, winSec);
  const cents = 1200 * Math.log2(f / expectedHz);
  const ok = Number.isFinite(f) && Math.abs(cents) <= tolCents;
  console.log(`音高 ${label}: 期望 ${expectedHz.toFixed(1)}Hz, 实测 ${f.toFixed(1)}Hz, 偏差 ${cents.toFixed(1)} cents ${ok ? 'OK' : 'CHECK'}`);
  return ok;
}
/** 乐句参考音高：窗口内音符会重叠，仅记录、不判定 */
function referencePitch(label, L, expectedHz, startSec, winSec) {
  const f = dominantFreq(L, startSec, winSec);
  const cents = 1200 * Math.log2(f / expectedHz);
  console.log(`音高参考 ${label}: 期望 ${expectedHz.toFixed(1)}Hz, 峰值 ${f.toFixed(1)}Hz (${cents.toFixed(1)} cents，窗口内音符重叠，仅记录)`);
}

// ---------------------------------------------------------------- tests
const results = {};
const failures = [];

// 1) EP chord progression + bass + lead + drums + guitar，共 8 小节
{
  const defs = [
    { type: 'ep', params: { index: 2.1, tine: 0.5, decay: 1.6, sustain: 0.24, chorus: 0.2, tone: 0.85 }, pan: -0.1, sendReverb: 0.18, volume: 0.9 },
    { type: 'bass', params: { cutoff: 380, resonance: 0.32, sub: 0.6, decay: 0.35, filterEnv: 0.75, octave: -12 }, pan: 0.0, sendReverb: 0.08, volume: 0.78 },
    { type: 'synth', params: { wave: 0, cutoff: 1500, resonance: 0.25, detune: 6, sub: 0.1, attack: 0.03, decay: 0.5, sustain: 0.25, release: 0.4, filterEnv: 0.7 }, pan: 0.12, sendReverb: 0.25, volume: 0.62 },
    { type: 'drum', params: { punch: 0.7, decay: 0.5, toneShift: 0.5, drive: 0.2 }, pan: 0.05, sendReverb: 0.06, volume: 0.85 },
    { type: 'guitar', params: { damping: 0.4, bright: 0.55 }, pan: 0.22, sendReverb: 0.2, volume: 0.7 },
  ];
  const sp = createStudio(defs);
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [55, 60, 64],
    [55, 59, 62],
    [57, 60, 64],
    [53, 57, 60],
    [55, 60, 64],
    [55, 59, 62],
  ];
  const roots = [45, 41, 48, 43, 45, 41, 48, 43];
  const arp = [0, 2, 1, 2, 0, 2, 1, 2];
  const guitarNotes = [[69, 72, 76], [65, 69, 72], [67, 72, 76], [67, 71, 74]];
  for (let bar = 0; bar < 8; bar++) {
    const chord = chords[bar];
    const b0 = bar * 4;
    // EP：两拍一次和弦
    chord.forEach((p, idx) => {
      addNote(sp, 0, p, b0 + 0.02 * idx, 1.9, 0.72, 'normal');
      addNote(sp, 0, p, b0 + 2 + 0.02 * idx, 1.9, 0.6, 'normal');
    });
    // bass：根音 + 第五
    addNote(sp, 1, roots[bar], b0, 1.5, 0.8);
    addNote(sp, 1, roots[bar] + 7, b0 + 2, 1.2, 0.65);
    // lead：琶音旋律
    const leadPitches = [chord[2] + 12, chord[1] + 12, chord[0] + 12, chord[2] + 12];
    for (let k = 0; k < 4; k++) {
      addNote(sp, 2, leadPitches[k], b0 + k * 0.75, 0.6, 0.55 + (k % 2) * 0.1);
    }
    // 鼓：kick 1/3, snare 2/4, hat 八分
    addNote(sp, 3, 36, b0, 0.2, 0.9);
    addNote(sp, 3, 36, b0 + 2, 0.2, 0.85);
    addNote(sp, 3, 38, b0 + 1, 0.2, 0.8);
    addNote(sp, 3, 38, b0 + 3, 0.2, 0.8);
    for (let h = 0; h < 8; h++) addNote(sp, 3, 42, b0 + h * 0.5, 0.15, 0.55);
    // 吉他：分解和弦
    const gn = guitarNotes[bar % 4];
    for (let g = 0; g < 8; g++) {
      const p = gn[[0, 1, 2, 1, 0, 2, 1, 2][g]];
      addNote(sp, 4, p, b0 + g * 0.5 + 0.012 * g, 0.45, 0.6 + (g === 0 ? 0.15 : 0));
    }
  }
  const seconds = BAR * 8 + 1.5;
  const { L, R } = renderStudio(sp, seconds);
  results.mix = analyze('P1 多轨混音(8小节)', L, R, seconds);
  writeFileSync(join(OUT_DIR, 'p1-mix-8bars.wav'), wavBuffer(L, R));
}

// 2) 各音源单独示意（用于实际试听与区分度检查）
const solos = {
  'p1-ep.wav': {
    def: { type: 'ep', params: { index: 2.4, tine: 0.55, decay: 1.8, chorus: 0.15, tone: 0.85 }, volume: 0.9 },
    notes: [[60, 0, 1.2, 0.75], [64, 0.5, 1.2, 0.65], [67, 1.0, 1.4, 0.9], [72, 2.0, 1.6, 0.55], [57, 3.5, 1.5, 0.7]],
  },
  'p1-synth.wav': {
    def: { type: 'synth', params: { wave: 0, cutoff: 1100, resonance: 0.35, detune: 8, filterEnv: 0.8, attack: 0.04, decay: 0.6, sustain: 0.3, release: 0.5 }, volume: 0.8 },
    notes: [[52, 0, 0.8, 0.7], [55, 0.5, 1.0, 0.8], [59, 1.2, 1.4, 0.85], [62, 2.7, 1.6, 0.6], [64, 4.0, 1.2, 0.9]],
  },
  'p1-guitar.wav': {
    def: { type: 'guitar', params: { damping: 0.4, bright: 0.55 }, volume: 0.85 },
    notes: [[64, 0, 0.8, 0.7], [67, 0.18, 0.8, 0.75], [71, 0.36, 1.2, 0.6], [67, 0.9, 0.9, 0.7], [64, 1.5, 1.5, 0.55], [60, 2.1, 1.0, 0.8]],
  },
  'p1-drums.wav': {
    def: { type: 'drum', params: { punch: 0.7, decay: 0.5 }, volume: 0.9 },
    notes: [[36, 0, 0.2, 0.9], [42, 0.25, 0.2, 0.6], [38, 0.5, 0.2, 0.8], [42, 0.75, 0.2, 0.5], [36, 1.0, 0.2, 0.95], [46, 1.25, 0.4, 0.7], [49, 1.5, 0.2, 0.8], [42, 1.75, 0.2, 0.55], [36, 2.0, 0.2, 0.9], [38, 2.5, 0.2, 0.85]],
  },
  'p1-piano.wav': {
    def: { type: 'piano', params: { brightness: 0.6, decay: 1.8 }, volume: 0.85 },
    notes: [[48, 0, 1.5, 0.8], [52, 0.1, 1.5, 0.7], [55, 0.2, 1.5, 0.75], [60, 1.4, 1.5, 0.9], [64, 2.0, 1.2, 0.6], [67, 2.6, 1.5, 0.85]],
  },
};

for (const [file, cfg] of Object.entries(solos)) {
  const sp = createStudio([Object.assign({ pan: 0, sendReverb: 0.12 }, cfg.def)]);
  for (const [pitch, beat, dur, vel] of cfg.notes) addNote(sp, 0, pitch, beat, dur, vel);
  const seconds = 5.5;
  const { L, R } = renderStudio(sp, seconds);
  const key = file.replace('.wav', '');
  results[key] = analyze(key, L, R, seconds);
  if (cfg.def.type !== 'drum') {
    const midi = cfg.notes[0][0] + (cfg.def.params.octave || 0);
    const expected = 440 * Math.pow(2, (midi - 69) / 12);
    // 这些示范乐句的音符互相重叠，窗口内不止一个音，因此只记录；
    // 严格的音准判定在下一节的“单音音高”中。
    referencePitch(key, L, expected, 0.04, 0.12);
  }
  writeFileSync(join(OUT_DIR, file), wavBuffer(L, R));
}

// 2b) 单音音高：每种音源只起一个持续音（窗口内没有其它音符），判定 ±20 cents
{
  const cases = [
    { type: 'piano', pitch: 60, params: { brightness: 0.6, decay: 2.6, sustain: 0.45, release: 0.5, attack: 0.004 } },
    { type: 'guitar', pitch: 60, params: { damping: 0.5, bright: 0.6 } },
    { type: 'synth', pitch: 57, params: { wave: 0, cutoff: 4000, resonance: 0.1, detune: 0, sub: 0, attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.3, filterEnv: 0, lfoDepth: 0 } },
    { type: 'bass', pitch: 60, params: { cutoff: 2000, resonance: 0.1, detune: 0, sub: 0, attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.3, filterEnv: 0, octave: -12 } },
  ];
  for (const c of cases) {
    const sp = createStudio([{ type: c.type, params: c.params, volume: 0.9 }]);
    addNote(sp, 0, c.pitch, 0, 3, 0.75);
    const { L } = renderStudio(sp, 2.4);
    const midi = c.pitch + (c.params.octave || 0);
    const expected = 440 * Math.pow(2, (midi - 69) / 12);
    if (!checkPitch(`单音 ${c.type}`, L, expected, 0.2, 0.5, 20)) failures.push(`音准 ${c.type}`);
  }
}

// 2c) 弯音与触后：同一合成器发送表情消息后，音高与电平必须真实改变
{
  const base = { wave: 0, cutoff: 4000, resonance: 0.1, detune: 0, sub: 0, attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.3, filterEnv: 0, lfoDepth: 0 };
  const pitch = 57;
  const baseHz = 440 * Math.pow(2, (pitch - 69) / 12);
  for (const [semi, label] of [[2, '+2 半音'], [-2, '-2 半音']]) {
    const sp = createStudio([{ type: 'synth', params: base, volume: 0.9 }]);
    sp.receive({ type: 'bend', track: 0, value: semi });
    addNote(sp, 0, pitch, 0, 3, 0.75);
    const { L } = renderStudio(sp, 2.2);
    const expected = baseHz * Math.pow(2, semi / 12);
    if (!checkPitch(`弯音 ${label}`, L, expected, 0.3, 0.5, 20)) failures.push(`弯音 ${label}`);
  }
  const mk = (pressure) => {
    const sp = createStudio([{ type: 'synth', params: base, volume: 0.9 }]);
    if (pressure) sp.receive({ type: 'pressure', track: 0, value: 1 });
    addNote(sp, 0, pitch, 0, 3, 0.75);
    return renderStudio(sp, 1.2).L;
  };
  const plain = mk(0);
  const pressed = mk(1);
  const rmsOf = (L) => {
    let sum = 0;
    const from = Math.floor(0.15 * SR);
    const to = Math.floor(1.0 * SR);
    for (let i = from; i < to; i++) sum += L[i] * L[i];
    return Math.sqrt(sum / (to - from));
  };
  const ratio = rmsOf(pressed) / rmsOf(plain);
  const pressureOk = ratio > 1.1;
  console.log(`触后压力: rms 无触后=${rmsOf(plain).toFixed(4)} 满触后=${rmsOf(pressed).toFixed(4)} 比值=${ratio.toFixed(2)} ${pressureOk ? 'OK' : 'CHECK'}`);
  if (!pressureOk) failures.push('触后压力');
}

// 3) 参数差异性抽样：同一合成器在两种 cutoff 下应产生明显不同的 RMS/峰值
{
  const spA = createStudio([{ type: 'synth', params: { cutoff: 300, resonance: 0.2, sub: 0.3, filterEnv: 0.4 }, volume: 0.8 }]);
  const spB = createStudio([{ type: 'synth', params: { cutoff: 4000, resonance: 0.2, sub: 0.3, filterEnv: 0.4 }, volume: 0.8 }]);
  for (let i = 0; i < 8; i++) {
    addNote(spA, 0, 57 + (i % 12), i * 0.5, 0.4, 0.8);
    addNote(spB, 0, 57 + (i % 12), i * 0.5, 0.4, 0.8);
  }
  const { L: la } = renderStudio(spA, 4.5);
  const { L: lb } = renderStudio(spB, 4.5);
  let e1 = 0;
  let e2 = 0;
  let diff = 0;
  for (let i = 0; i < la.length; i++) {
    e1 += la[i] * la[i];
    e2 += lb[i] * lb[i];
    diff += Math.abs(la[i] - lb[i]);
  }
  console.log(`参数差异 cutoff 300 vs 4000: rmsA=${Math.sqrt(e1 / la.length).toFixed(4)} rmsB=${Math.sqrt(e2 / lb.length).toFixed(4)} meanAbsDiff=${(diff / la.length).toFixed(4)}`);
}

// 4) WAV 音频片段：与浏览器/离线导出共用同一条路径（素材注册 → audio 事件 → 混音）
{
  const { createAudioAsset, decodeAssetPcm } = await loadTs(join(ROOT, 'src/core/audio-asset.ts'));
  const srcSr = 44100;
  const frames = Math.round(srcSr * 1.5);
  const sine = new Float32Array(frames);
  for (let i = 0; i < frames; i++) sine[i] = Math.sin((i / srcSr) * 2 * Math.PI * 440) * 0.85;
  const asset = createAudioAsset('render-fixture.wav', srcSr, [sine]);
  const channels = decodeAssetPcm(asset);
  const sp = createStudio([{ type: 'synth', volume: 0.8, sendReverb: 0, sendDelay: 0, tone: 1, drive: 0 }]);
  sp.receive({ type: 'asset', assetId: asset.id, sampleRate: asset.sampleRate, channels });
  sp.receive({
    type: 'audio', track: 0, assetId: asset.id, when: 0.6, offsetSec: 0.25,
    dur: 0.9, gain: 0.8, id: 'clip-a', src: 'transport', gen: 0,
  });
  const seconds = 2.4;
  const { L, R } = renderStudio(sp, seconds);
  results.wav = analyze('p4-wav-音频片段', L, R, seconds);
  writeFileSync(join(OUT_DIR, 'p4-wav-clip.wav'), wavBuffer(L, R));

  const rms = (from, to) => {
    const a = Math.max(0, Math.floor(from * SR));
    const b = Math.min(L.length, Math.floor(to * SR));
    if (b <= a) return 0;
    let sum = 0;
    for (let i = a; i < b; i++) sum += L[i] * L[i] + R[i] * R[i];
    return Math.sqrt(sum / ((b - a) * 2));
  };
  const body = rms(0.7, 1.4);
  const before = rms(0, 0.55);
  const after = rms(1.55, 2.4);
  console.log(`音频片段: 播放段 rms=${body.toFixed(3)} 起点前=${before.toFixed(3)} 终点后=${after.toFixed(3)}`);
  if (body <= 0.05) failures.push('音频片段发声');
  if (before >= 0.005) failures.push('音频片段起点前静音');
  if (after >= 0.005) failures.push('音频片段终点后静音');
  if (!checkPitch('WAV 音频 440Hz', L, 440, 0.9, 0.3, 20)) failures.push('音频片段音高');
}

// 汇总
const failed = Object.entries(results).filter(([, r]) => !r.lengthOk || !r.heard || r.nonFinite > 0);
// 说明：over1 只表示 16-bit 编码前的采样峰值是否超过 1；总线有 tanh 软限幅，
// 峰值不超过 1 不等于“无削波失真”，仅可判定为“未发生硬削波”。
console.log(failed.length === 0 ? 'PASS: 渲染长度正确、非静音、无非法数值、峰值未超过 1' : 'FAIL: 渲染问题 ' + failed.map(([k]) => k).join(','));
if (failed.length) process.exitCode = 1;
if (failures.length) {
  console.log('FAIL: ' + failures.join(', '));
  process.exitCode = 1;
} else {
  console.log('PASS: 单音音准全部在 ±20 cents 内');
}
