/**
 * Generative Ambient 模块（M6 用户 A/B 偏好适配）回归测试。
 * 用法：node tools/ambient-preference-tests.mjs
 * 覆盖：偏好方向学习、确定性、小样本不应用、应用回补合法、变体对生成、特征提取闭环。
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

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
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

const base = amb.getPreset('sparse-fog');

// ----------------------------------------------------------------- empty / 方向学习
{
  const p = amb.emptyPreference();
  check('初始：direction 全 0', ['density', 'brightness', 'dissonance', 'stability', 'tempo', 'recurrence'].every((d) => p.direction[d] === 0));
  check('初始：samples 全 0', p.samples.density === 0 && p.samples.tempo === 0);
  check('初始：totalComparisons=0', p.totalComparisons === 0);

  const a = { density: 0.8, brightness: 0.5, dissonance: 0.3, stability: 0.6, tempo: 0.5, recurrence: 0.4 };
  const b = { density: 0.2, brightness: 0.5, dissonance: 0.3, stability: 0.6, tempo: 0.5, recurrence: 0.4 };
  amb.recordPreference(p, a, b, 'a');
  amb.recordPreference(p, a, b, 'a');
  amb.recordPreference(p, a, b, 'a');
  check('学习：偏好高密度（direction>0）', p.direction.density > 0.5, `density.dir=${p.direction.density.toFixed(3)}`);
  check('学习：samples 累计', p.samples.density === 3, `n=${p.samples.density}`);
  check('学习：无关维度不动', p.direction.brightness === 0 && p.direction.stability === 0);
  check('学习：totalComparisons=3', p.totalComparisons === 3);

  // 反向偏好（winner b）
  const p2 = amb.emptyPreference();
  amb.recordPreference(p2, a, b, 'b');
  amb.recordPreference(p2, a, b, 'b');
  amb.recordPreference(p2, a, b, 'b');
  check('学习：偏好低密度（direction<0）', p2.direction.density < -0.5, `density.dir=${p2.direction.density.toFixed(3)}`);
}

// ----------------------------------------------------------------- 确定性
{
  const mk = () => {
    const p = amb.emptyPreference();
    const a = { density: 0.7, brightness: 0.2, dissonance: 0.5, stability: 0.4, tempo: 0.6, recurrence: 0.3 };
    const b = { density: 0.3, brightness: 0.6, dissonance: 0.1, stability: 0.8, tempo: 0.4, recurrence: 0.7 };
    amb.recordPreference(p, a, b, 'a');
    amb.recordPreference(p, a, b, 'b');
    return p;
  };
  check('确定性：同输入同结果', JSON.stringify(mk()) === JSON.stringify(mk()));
}

// ----------------------------------------------------------------- 特征提取（纯函数）
{
  const prof = {
    meso: { onsetDensity: 2, pitchStability: 0.75, chroma: [], tonic: 57, tonicStrength: 0.5, stereoWidth: 0.3, dynamicsDb: 6 },
    micro: { brightness: 0.6, roughness: 0.4, flatness: 0.2, centroidHz: 1200, rolloffHz: 2000, rms: 0.1, crest: 3, flux: 0.1, attack: 0.2 },
    macro: { recurrence: 0.5, densityDrift: 0, brightnessDrift: 0, tensionDrift: 0, durationSec: 30 },
  };
  const f = amb.preferenceFeaturesFromProfile(prof, 80);
  check('提取：各维 0..1', ['density', 'brightness', 'dissonance', 'stability', 'tempo', 'recurrence'].every((d) => f[d] >= 0 && f[d] <= 1));
  check('提取：density 归一化', f.density === 0.5, `d=${f.density}`);
  check('提取：tempo 归一化', f.tempo === 0.4, `t=${f.tempo}`);
}

// ----------------------------------------------------------------- 变体对
{
  const pair = amb.pairForComparison(base, 'pair-seed');
  const pair2 = amb.pairForComparison(base, 'pair-seed');
  check('变体对：A/B 合法', pair.a.schemaVersion === amb.STYLE_SCHEMA_VERSION && pair.b.schemaVersion === amb.STYLE_SCHEMA_VERSION && pair.a.agents.length === base.agents.length && pair.b.agents.length === base.agents.length);
  check('变体对：A/B 不同', JSON.stringify(pair.a) !== JSON.stringify(pair.b));
  check('变体对：确定性', JSON.stringify(pair.a) === JSON.stringify(pair2.a) && JSON.stringify(pair.b) === JSON.stringify(pair2.b));
}

// ----------------------------------------------------------------- 小样本不应用
{
  const p = amb.emptyPreference();
  p.direction.density = 0.9;
  p.samples.density = 1; // 样本不足
  const r = amb.applyPreference(base, p);
  check('小样本：不应用（changes 空）', r.changes.length === 0);
  check('小样本：homeostasis 不变', JSON.stringify(r.preset.homeostasis) === JSON.stringify(base.homeostasis));
}

// ----------------------------------------------------------------- 应用回补
{
  const p = amb.emptyPreference();
  p.direction.density = 0.5; p.samples.density = 3;
  p.direction.brightness = -0.3; p.samples.brightness = 3;
  p.direction.tempo = 0.4; p.samples.tempo = 3;
  const r = amb.applyPreference(base, p);
  check('应用：density 目标上调', r.preset.homeostasis.density.min >= base.homeostasis.density.min && r.preset.homeostasis.density.max >= base.homeostasis.density.max);
  check('应用：brightness 目标下调', r.preset.homeostasis.brightness.max <= base.homeostasis.brightness.max);
  check('应用：tempo 区间上调', r.preset.tempo.min > base.tempo.min);
  check('应用：changes 记录', r.changes.length >= 3, `changes=${r.changes.join(',')}`);
  check('应用：schemaVersion 保持', r.preset.schemaVersion === base.schemaVersion);
  check('应用：无 NaN', allFinite(r.preset));
  check('应用：变体仍可生成（Agent 数不变）', r.preset.agents.length === base.agents.length);
}

// ----------------------------------------------------------------- 端到端特征闭环（生成→渲染→分析）
{
  const { features } = amb.preferenceFeaturesFromPreset(base, { seed: 'pref-e2e', seconds: 8 });
  check('闭环：特征合法 0..1', ['density', 'brightness', 'dissonance', 'stability', 'tempo', 'recurrence'].every((d) => features[d] >= 0 && features[d] <= 1));
  check('闭环：无 NaN', allFinite(features));
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;