/**
 * Generative Ambient 模块（M1 Procedural Core）回归测试。
 * 用法：node tools/ambient-tests.mjs
 * 覆盖：确定性 RNG、进程、4 预设、确定/统计一致、结构合法、无 NaN、
 *       MIDI 导出、5 分钟生成、事件可追溯。
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

// 兜底 localStorage（宿主 presets 模块懒加载用户音色时可能访问）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const amb = await loadTs(join(ROOT, 'src/ambient/index.ts'));
const midiMod = await loadTs(join(ROOT, 'src/core/midi.ts'));
const projMod = await loadTs(join(ROOT, 'src/core/project.ts'));

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

// ----------------------------------------------------------------- RNG
{
  const a = new amb.Rng('fixed-seed');
  const b = new amb.Rng('fixed-seed');
  const sa = Array.from({ length: 5 }, () => a.next());
  const sb = Array.from({ length: 5 }, () => b.next());
  check('RNG：同 seed 序列一致', JSON.stringify(sa) === JSON.stringify(sb));
  check('RNG：同 seed 首值确定', sa[0] === new amb.Rng('fixed-seed').next());
  check('RNG：不同 seed 序列不同', new amb.Rng('x').next() !== new amb.Rng('y').next());
  check('RNG：hashSeed 确定', amb.hashSeed('hello') === amb.hashSeed('hello'));
}

// ----------------------------------------------------------------- 预设
{
  const ids = amb.presetIds();
  check('预设：至少 4 个', ids.length >= 4);
  for (const id of ['sparse-fog', 'phase-garden', 'still-room', 'pentatonic-weather']) {
    check(`预设：存在 ${id}`, ids.includes(id));
  }
  let ok = true;
  for (const id of ids) {
    const p = amb.getPreset(id);
    if (p.schemaVersion !== amb.STYLE_SCHEMA_VERSION) ok = false;
    if (p.agents.length < 2) ok = false;
  }
  check('预设：schemaVersion 正确且均含 ≥2 Agent', ok);

  const pitchIds = new Set();
  const rhythmIds = new Set();
  for (const id of ids) {
    for (const a of amb.getPreset(id).agents) {
      pitchIds.add(a.pitch.id);
      rhythmIds.add(a.rhythm.id);
    }
  }
  check('预设：音高进程 ≥4 种算法被使用', pitchIds.size >= 4);
  check('预设：节奏进程 ≥4 种算法被使用', rhythmIds.size >= 4);

  // 4 个预设的「音高+节奏」签名互不相同（算法组合各自不同）
  const signatures = new Set(ids.map((id) => amb.getPreset(id).agents.map((a) => `${a.pitch.id}:${a.rhythm.id}`).sort().join('+')));
  check('预设：4 预设算法组合互不相同', signatures.size === ids.length);
}

// ----------------------------------------------------------------- 生成：确定性
{
  const g1 = amb.generateAmbientPiece({ presetId: 'phase-garden', seed: 'abc', durationSec: 60, tempo: 90 });
  const g2 = amb.generateAmbientPiece({ presetId: 'phase-garden', seed: 'abc', durationSec: 60, tempo: 90 });
  check('确定：同 seed 事件数一致', g1.stats.eventCount === g2.stats.eventCount);
  check('确定：同 seed 音符序列一致', JSON.stringify(g1.project.clips.map((c) => c.notes)) === JSON.stringify(g2.project.clips.map((c) => c.notes)));
  check('确定：同 seed 统计一致', g1.stats.meanPitch === g2.stats.meanPitch && g1.stats.meanVelocity === g2.stats.meanVelocity);
}

// ----------------------------------------------------------------- 生成：不同 seed 统计风格一致
{
  const seeds = ['s1', 's2', 's3'];
  const runs = seeds.map((seed) => amb.generateAmbientPiece({ presetId: 'pentatonic-weather', seed, durationSec: 60, tempo: 78 }).stats);
  const counts = runs.map((r) => r.eventCount);
  const means = runs.map((r) => r.meanPitch);
  const vels = runs.map((r) => r.meanVelocity);
  const countSpread = (Math.max(...counts) - Math.min(...counts)) / (Math.max(1, Math.min(...counts)));
  const pitchSpread = Math.max(...means) - Math.min(...means);
  check('统计：不同 seed 事件数在同量级', countSpread < 0.5, `spread=${countSpread.toFixed(2)}`);
  check('统计：不同 seed 平均音高接近', pitchSpread < 8, `spread=${pitchSpread.toFixed(2)}`);
  check('统计：不同 seed 平均力度在合理区间', vels.every((v) => v > 0.1 && v < 0.9));

  const notesA = JSON.stringify(amb.generateAmbientPiece({ presetId: 'pentatonic-weather', seed: 'a1', durationSec: 30 }).project.clips.map((c) => c.notes));
  const notesB = JSON.stringify(amb.generateAmbientPiece({ presetId: 'pentatonic-weather', seed: 'b2', durationSec: 30 }).project.clips.map((c) => c.notes));
  check('统计：不同 seed 音符序列不同', notesA !== notesB);
}

// ----------------------------------------------------------------- 生成：结构合法 + 无 NaN（每种预设跑一遍）
{
  let ok = true;
  let detail = '';
  for (const id of amb.presetIds()) {
    const preset = amb.getPreset(id);
    const g = amb.generateAmbientPiece({ presetId: id, seed: 'structure', durationSec: 20 });
    const p = g.project;
    const expectedTracks = preset.agents.length + (preset.texture?.length ?? 0);
    if (p.tracks.length !== expectedTracks) { ok = false; detail = `${id}:track数`; }
    if (!allFinite(p)) { ok = false; detail = `${id}:NaN`; }
    for (const agent of preset.agents) {
      const track = p.tracks.find((t) => t.id === `t:${agent.id}`);
      if (!track) { ok = false; detail = `${id}:缺轨 ${agent.id}`; continue; }
      const clip = p.clips.find((c) => c.trackId === track.id);
      if (!clip) { ok = false; detail = `${id}:缺片段 ${agent.id}`; continue; }
      if (clip.notes.length === 0) { ok = false; detail = `${id}:空片段 ${agent.id}`; continue; }
      for (const n of clip.notes) {
        if (!Number.isInteger(n.pitch) || n.pitch < agent.register.min || n.pitch > agent.register.max) { ok = false; detail = `${id}:音高 ${n.pitch}`; }
        if (!(n.velocity >= 0.05 && n.velocity <= 1)) { ok = false; detail = `${id}:力度 ${n.velocity}`; }
        if (!(n.length > 0) || !Number.isFinite(n.length)) { ok = false; detail = `${id}:时长 ${n.length}`; }
        if (!(n.start >= 0) || !Number.isFinite(n.start)) { ok = false; detail = `${id}:起点 ${n.start}`; }
      }
    }
  }
  check('结构：4 预设生成合法（轨道/片段/音高/力度/时长）', ok, detail);
}

// ----------------------------------------------------------------- 生成：≥70% pitched 素材可编辑（M1 为 100% MIDI）
{
  const g = amb.generateAmbientPiece({ presetId: 'sparse-fog', seed: 1, durationSec: 30 });
  const notes = g.project.clips.flatMap((c) => c.notes);
  check('素材：全部为可编辑 MIDI 音符', notes.length > 0 && notes.every((n) => Number.isInteger(n.pitch)));
}

// ----------------------------------------------------------------- MIDI 导出复用 writeMidi
{
  const p = amb.generateAmbient({ presetId: 'phase-garden', seed: 'midi', durationSec: 30, tempo: 90 });
  const buf = midiMod.writeMidi(p);
  check('MIDI：导出为有效 ArrayBuffer', buf instanceof ArrayBuffer && buf.byteLength > 100, `len=${buf.byteLength}`);
  // 反解验证可读
  const parsed = midiMod.parseMidi(buf);
  check('MIDI：可解析且含音符轨', parsed.tracks.length >= 1 && parsed.tracks.some((t) => t.notes.length > 0));
}

// ----------------------------------------------------------------- 5 分钟生成 + 事件不爆炸
{
  const g = amb.generateAmbientPiece({ presetId: 'phase-garden', seed: 42, durationSec: 300 });
  check('5 分钟：时长正确', g.stats.totalSeconds === 300, `=${g.stats.totalSeconds}`);
  check('5 分钟：有音符产出', g.stats.eventCount > 20, `n=${g.stats.eventCount}`);
  check('5 分钟：无事件爆炸', g.stats.eventCount < 20000, `n=${g.stats.eventCount}`);
  check('5 分钟：无 NaN', allFinite(g.project));
  check('5 分钟：接受率在 (0,1)', g.stats.acceptedRatio > 0 && g.stats.acceptedRatio < 1, `r=${g.stats.acceptedRatio.toFixed(3)}`);
}

// ----------------------------------------------------------------- 事件可追溯
{
  const g = amb.generateAmbientPiece({ presetId: 'phase-garden', seed: 'trace', durationSec: 15 });
  const e0 = g.events[0];
  check('追溯：事件含 RuleOrigin', !!e0 && typeof e0.origin.agentId === 'string' && typeof e0.origin.ruleId === 'string' && typeof e0.origin.processId === 'string' && typeof e0.origin.seed === 'string');
  // 每个音符 id 编码其所属 Agent（trackId = `t:${spec.id}`）
  let encoded = true;
  for (const clip of g.project.clips) {
    const agentId = clip.trackId.slice(2);
    for (const n of clip.notes) {
      if (n.id.split(':')[1] !== agentId) encoded = false;
    }
  }
  check('追溯：每个音符 id 编码其 Agent', encoded);
}

// ----------------------------------------------------------------- 元数据回写 + 序列化往返
{
  const p = amb.generateAmbient({ presetId: 'still-room', seed: 'meta', durationSec: 30 });
  check('元数据：工程携带 ambient', p.ambient && p.ambient.presetId === 'still-room' && p.ambient.seed === 'meta');
  const text = projMod.serializeProject(p);
  const restored = projMod.parseProject(text);
  check('往返：ambient 元数据保留', restored.ambient && restored.ambient.presetId === 'still-room' && restored.ambient.seed === 'meta');
  check('往返：音符不丢失', restored.clips.flatMap((c) => c.notes).length === p.clips.flatMap((c) => c.notes).length);
  // 相同 seed 重新生成 → 内容一致（恢复 seed 后可再生）
  const again = amb.generateAmbient({ presetId: p.ambient.presetId, seed: p.ambient.seed, durationSec: 30 });
  check('往返：seed 再生内容一致', JSON.stringify(again.clips.map((c) => c.notes)) === JSON.stringify(p.clips.map((c) => c.notes)));
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;