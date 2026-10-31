/**
 * Generative Ambient 模块（M3 AudioAnalyzer + ReferenceProfile + 手工映射）回归测试。
 * 用法：node tools/ambient-analysis-tests.mjs
 * 覆盖：FFT 正确性、downmix、参考特征（正弦/白噪声）、聚合一致性/不确定性、
 *       手工映射产出合法 StylePreset、确定性、无 NaN。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function loadTs(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(url);
}

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const amb = await loadTs(join(ROOT, 'src/ambient/index.ts'));
const fftMod = await loadTs(join(ROOT, 'src/ambient/fft.ts'));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function collectNumbers(x, out) {
  if (typeof x === 'number') { out.push(x); return; }
  if (Array.isArray(x)) { for (const v of x) collectNumbers(v, out); return; }
  if (x && typeof x === 'object') { for (const k of Object.keys(x)) collectNumbers(x[k], out); }
}
function allFinite(x) {
  const nums = [];
  collectNumbers(x, nums);
  return nums.every((n) => Number.isFinite(n));
}

const SR = 22050;

/** 合成正弦（单声道） */
function sine(freq, seconds, amp = 0.5) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

/** 合成白噪声（确定性，seed 用于简易 LCG） */
function noise(seconds, seed = 1) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = (s / 0xffffffff) * 2 - 1; // -1..1
  }
  return x;
}

// ----------------------------------------------------------------- FFT 正确性
{
  const sr = 22050;
  const fft = 1024;
  const re = new Float64Array(fft);
  for (let i = 0; i < fft; i++) re[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
  const { magnitude } = fftMod.magnitudeSpectrum(re, fft);
  let peak = 0;
  for (let k = 1; k < magnitude.length; k++) if (magnitude[k] > magnitude[peak]) peak = k;
  const peakHz = (peak * sr) / fft;
  check('FFT：440Hz 正弦峰值 bin 落于 440 附近', peakHz > 390 && peakHz < 490, `peak=${peakHz.toFixed(1)}Hz`);
}

// ----------------------------------------------------------------- downmix
{
  const mono = new Float32Array([1, 2, 3, 4]);
  check('downmix：单声道原样返回', amb.downmix([mono]) === mono);
  const L = new Float32Array([1, 1, 1, 1]);
  const R = new Float32Array([3, 3, 3, 3]);
  const m = amb.downmix([L, R]);
  check('downmix：双声道取均值', Math.abs(m[0] - 2) < 1e-6 && Math.abs(m[3] - 2) < 1e-6);
}

// ----------------------------------------------------------------- analyzeReference：440Hz 正弦
{
  const prof = amb.analyzeReference([sine(440, 1)], SR, 'sine440');
  check('分析：正弦 centroid ≈ 440Hz', prof.micro.centroidHz > 350 && prof.micro.centroidHz < 530, `centroid=${prof.micro.centroidHz.toFixed(1)}`);
  check('分析：正弦谱平坦度低', prof.micro.flatness < 0.2, `flatness=${prof.micro.flatness.toFixed(3)}`);
  check('分析：正弦 tonic 为 A（57）', prof.meso.tonic === 57, `tonic=${prof.meso.tonic}`);
  check('分析：正弦调性置信度高', prof.meso.tonicStrength > 0.5, `strength=${prof.meso.tonicStrength.toFixed(3)}`);
  check('分析：正弦音高稳定性高', prof.meso.pitchStability > 0.5, `stab=${prof.meso.pitchStability.toFixed(3)}`);
  check('分析：稳态正弦 onset 密度≈0', prof.meso.onsetDensity < 3, `density=${prof.meso.onsetDensity.toFixed(2)}`);
  check('分析：单声道立体声宽度=0', prof.meso.stereoWidth === 0);
  check('分析：正弦轮廓无 NaN', allFinite(prof));
}

// ----------------------------------------------------------------- analyzeReference：白噪声
{
  const prof = amb.analyzeReference([noise(1, 7)], SR, 'noise');
  check('分析：白噪声谱平坦度高', prof.micro.flatness > 0.35, `flatness=${prof.micro.flatness.toFixed(3)}`);
  check('分析：白噪声调性置信度低', prof.meso.tonicStrength < 0.45, `strength=${prof.meso.tonicStrength.toFixed(3)}`);
  check('分析：白噪声音高稳定性低', prof.meso.pitchStability < 0.65, `stab=${prof.meso.pitchStability.toFixed(3)}`);
  check('分析：白噪声亮度更高', prof.micro.brightness > 0.25, `brightness=${prof.micro.brightness.toFixed(3)}`);
  check('分析：白噪声轮廓无 NaN', allFinite(prof));
}

// ----------------------------------------------------------------- chroma / tonic 估计基本性质
{
  // 纯 A 音级 one-hot chroma → tonic = 57
  const a = new Array(12).fill(0);
  a[9] = 1;
  const t = amb.estimateTonalCenter(a);
  check('调性估计：A one-hot → tonic 57', t.tonic === 57 && t.tonicStrength > 0.5);
  const sA = amb.pitchStabilityFromChroma(a);
  const sU = amb.pitchStabilityFromChroma(new Array(12).fill(1));
  check('稳定性：one-hot 高、均匀低', sA > 0.9 && sU < 0.1, `one-hot=${sA.toFixed(3)} uniform=${sU.toFixed(3)}`);
}

// ----------------------------------------------------------------- aggregateReferences：一致性与聚合
{
  const p1 = amb.analyzeReference([sine(440, 1)], SR, 'a');
  const p2 = amb.analyzeReference([sine(440, 1)], SR, 'b');
  const agg = amb.aggregateReferences([p1, p2]);
  check('聚合：count=2', agg.count === 2);
  check('聚合：同源一致性高', agg.certainty > 0.7, `certainty=${agg.certainty.toFixed(3)}`);
  check('聚合：centroid 取均值', Math.abs(agg.micro.centroidHz - p1.micro.centroidHz) < 1e-9);
  check('聚合：无 NaN', allFinite(agg));

  // 混入噪声 → 一致性下降
  const agg2 = amb.aggregateReferences([p1, amb.analyzeReference([noise(1, 3)], SR, 'c')]);
  check('聚合：分歧增大→一致性下降', agg2.certainty < agg.certainty, `mix=${agg2.certainty.toFixed(3)}`);
}

// ----------------------------------------------------------------- aggregatedToPreset：映射合法
{
  const prof = amb.analyzeReference([sine(440, 2)], SR, 'ref');
  const agg = amb.aggregateReferences([prof]);
  const preset = amb.aggregatedToPreset(agg);
  check('映射：schemaVersion 正确', preset.schemaVersion === amb.STYLE_SCHEMA_VERSION);
  check('映射：id 前缀 ref-', preset.id.startsWith('ref-'));
  check('映射：name 非空', preset.name.length > 0);
  check('映射：含 ≥2 Agent', preset.agents.length >= 2);
  check('映射：scales 含所有 agent.scaleRef', preset.agents.every((a) => preset.scales[a.scaleRef] && preset.scales[a.scaleRef].length > 0));
  check('映射：agent 音区在 MIDI 范围内', preset.agents.every((a) => a.register.min >= 0 && a.register.max <= 127 && a.register.min <= a.register.max));
  check('映射：有纹理声部', (preset.texture?.length ?? 0) >= 1);
  check('映射：无 NaN', allFinite(preset));
  check('映射：可 JSON 序列化', (() => { try { JSON.stringify(preset); return true; } catch { return false; } })());

  const preset2 = amb.aggregatedToPreset(agg);
  check('映射：确定性（同入同出）', JSON.stringify(preset) === JSON.stringify(preset2));
}

// ----------------------------------------------------------------- referencesToPreset 端到端
{
  const refs = [amb.analyzeReference([sine(261.63, 1)], SR, 'c4'), amb.analyzeReference([sine(261.63, 1)], SR, 'c4b')];
  const preset = amb.referencesToPreset(refs);
  check('端到端：referencesToPreset 产出合法预设', preset.schemaVersion === amb.STYLE_SCHEMA_VERSION && preset.agents.length >= 2 && preset.id.startsWith('ref-'));
  const again = amb.referencesToPreset(refs);
  check('端到端：确定性', JSON.stringify(preset) === JSON.stringify(again));
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;