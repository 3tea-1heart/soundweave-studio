/**
 * Generative Ambient 模块（M4 逆拟合 + Quality Diversity / MAP-Elites）回归测试。
 * 用法：node tools/ambient-fitting-tests.mjs
 * 覆盖：变异算子合法、特征距离、fitPreset 收敛不退化、确定性、多样性、无 NaN、
 *       最优候选可作为合法 StylePreset 直接生成/可序列化。
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

const SR = 22050;

// 构造真实目标：用内置预设渲染短音频 → 分析 → 聚合
const srcProject = amb.generateAmbient({ presetId: 'sparse-fog', seed: 'target', durationSec: 10, tempo: 60 });
const rendered = amb.renderAmbient(srcProject, { sampleRate: SR });
const targetProf = amb.analyzeReference(rendered.channels, SR, 'target');
const target = amb.aggregateReferences([targetProf]);

// ----------------------------------------------------------------- 变异算子
{
  const base = amb.getPreset('sparse-fog');
  const rng1 = new amb.Rng('m');
  const rng2 = new amb.Rng('m');
  const m1 = amb.mutatePreset(base, rng1);
  const m2 = amb.mutatePreset(base, rng2);
  check('变异：确定性（同 seed 同结果）', JSON.stringify(m1) === JSON.stringify(m2));
  check('变异：schemaVersion 保留', m1.schemaVersion === amb.STYLE_SCHEMA_VERSION);
  check('变异：agent 数不变', m1.agents.length === base.agents.length);
  check('变异：scaleRef 仍有效', m1.agents.every((a) => m1.scales[a.scaleRef] && m1.scales[a.scaleRef].length > 0));
  check('变异：agent 音区合法', m1.agents.every((a) => a.register.min >= 0 && a.register.max <= 127 && a.register.min <= a.register.max));
  check('变异：weighted-field 长度==scale 长度', m1.agents.every((a) => a.pitch.id !== 'weighted-field' || !a.pitch.field || a.pitch.field.length === m1.scales[a.scaleRef].length));
  check('变异：无 NaN', allFinite(m1));
}

// ----------------------------------------------------------------- 特征距离
{
  const prof = amb.analyzeReference(rendered.channels, SR, 'self');
  const d = amb.profileDistance(prof, target);
  check('距离：非负且有限', Number.isFinite(d) && d >= 0, `d=${d.toFixed(3)}`);
  // 目标由同源信号聚合而来，特征距离应很小
  check('距离：同源自测距离小', d < 0.5, `d=${d.toFixed(3)}`);
  const d2 = amb.profileDistance(prof, target);
  check('距离：确定性', d === d2);
}

// ----------------------------------------------------------------- fitPreset 主流程
const fit = amb.fitPreset(target, { seed: 'fit-seed', iterations: 24, evaluateSeconds: 10, sampleRate: SR, initialSeeds: 4 });

{
  check('拟合：产出非空 elites', fit.elites.length >= 1, `n=${fit.elites.length}`);
  check('拟合：best 存在', !!fit.best && !!fit.best.preset);
  // baseline 也被归档，best 是全局最小
  check('拟合：best 不劣于 baseline', fit.best.distance <= fit.baseline.distance, `best=${fit.best.distance.toFixed(3)} baseline=${fit.baseline.distance.toFixed(3)}`);
  check('拟合：占用箱位数 ≥1', fit.occupiedBins >= 1, `bins=${fit.occupiedBins}`);
  check('拟合：无 NaN（best）', allFinite(fit.best));
  check('拟合：无 NaN（baseline）', allFinite(fit.baseline));
  check('拟合：best 是合法 StylePreset', fit.best.preset.schemaVersion === amb.STYLE_SCHEMA_VERSION && fit.best.preset.agents.length >= 2 && fit.best.preset.id.startsWith('ref-'));
  check('拟合：best 可 JSON 序列化', (() => { try { JSON.stringify(fit.best.preset); return true; } catch { return false; } })());
}

// ----------------------------------------------------------------- 确定性
{
  const fit2 = amb.fitPreset(target, { seed: 'fit-seed', iterations: 24, evaluateSeconds: 10, sampleRate: SR, initialSeeds: 4 });
  check('拟合：确定性（同 seed best 距离一致）', fit2.best.distance === fit.best.distance, `${fit2.best.distance} vs ${fit.best.distance}`);
  check('拟合：确定性（同 seed best 预设一致）', JSON.stringify(fit2.best.preset) === JSON.stringify(fit.best.preset));
  check('拟合：确定性（elites 数一致）', fit2.elites.length === fit.elites.length);
}

// ----------------------------------------------------------------- 最优候选可生成合法工程
{
  const proj = amb.generateAmbient({ preset: fit.best.preset, seed: 'gen-check', durationSec: 10 });
  const expectedTracks = fit.best.preset.agents.length + (fit.best.preset.texture?.length ?? 0);
  check('生成：best 预设产出合法工程（轨道数）', proj.tracks.length === expectedTracks, `tracks=${proj.tracks.length} expected=${expectedTracks}`);
  check('生成：best 工程无 NaN', allFinite(proj));
  const notes = proj.clips.flatMap((c) => c.notes);
  check('生成：best 工程有可编辑 MIDI 音符', notes.length > 0 && notes.every((n) => Number.isInteger(n.pitch)));
}

// ----------------------------------------------------------------- 多样性（MAP-Elites 核心验收）
{
  const fit3 = amb.fitPreset(target, { seed: 'fit-diverse', iterations: 40, evaluateSeconds: 10, sampleRate: SR, initialSeeds: 8 });
  check('多样性：archive 覆盖多个行为箱位', fit3.occupiedBins >= 2, `bins=${fit3.occupiedBins}/${fit3.elites.length} elites`);
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;