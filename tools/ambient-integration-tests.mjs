/**
 * Ambient 子系统与宿主集成回归测试。
 * 用法：node tools/ambient-integration-tests.mjs
 * 覆盖：生成结果即宿主 Project（合法音源类型/轨道≤15/引用完整/id 唯一/音符值域/非空），
 *       序列化往返不丢数据，同种子生成确定性，素材 PCM 可通过宿主解码。
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
const { serializeProject, parseProject } = await loadTs(join(ROOT, 'src/core/project.ts'));
const { decodeAssetPcm } = await loadTs(join(ROOT, 'src/core/audio-asset.ts'));

const VALID_TYPES = new Set(['ep', 'piano', 'guitar', 'synth', 'bass', 'drum']);

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

function projectValid(p, detail = '') {
  if (p.tracks.length === 0) return { ok: false, msg: `${detail}轨道为空` };
  if (p.tracks.length > 15) return { ok: false, msg: `${detail}轨道超限 ${p.tracks.length}` };
  const trackIds = new Set(p.tracks.map((t) => t.id));
  if (trackIds.size !== p.tracks.length) return { ok: false, msg: `${detail}轨道 id 重复` };
  const clipIds = new Set();
  const noteCount = [];
  for (const t of p.tracks) {
    if (!VALID_TYPES.has(t.instrument?.type)) return { ok: false, msg: `${detail}非法音源类型 ${t.instrument?.type}` };
    const clips = p.clips.filter((c) => c.trackId === t.id);
    noteCount.push(clips.reduce((s, c) => s + c.notes.length, 0));
    for (const c of clips) {
      if (clipIds.has(c.id)) return { ok: false, msg: `${detail}片段 id 重复 ${c.id}` };
      clipIds.add(c.id);
      for (const n of c.notes) {
        if (!Number.isFinite(n.pitch)) return { ok: false, msg: `${detail}非法音高` };
        if ((n.velocity ?? 0.7) <= 0 || (n.velocity ?? 0.7) > 1) return { ok: false, msg: `${detail}非法力度 ${n.velocity}` };
        if (!Number.isFinite(n.length) || n.length <= 0) return { ok: false, msg: `${detail}非法时值` };
      }
    }
  }
  const totalNotes = noteCount.reduce((a, b) => a + b, 0);
  if (totalNotes === 0) return { ok: false, msg: `${detail}零音符` };
  return { ok: true, msg: '', totalNotes };
}

// ----------------------------------------------------------------- 每个预设都产出宿主合法工程
{
  let allOk = true;
  let detail = '';
  for (const id of amb.presetIds()) {
    const g = amb.generateAmbientPiece({ presetId: id, seed: `int-${id}`, durationSec: 30 });
    const r = projectValid(g.project, `${id}:`);
    if (!r.ok) {
      allOk = false;
      detail = r.msg;
      break;
    }
    // 音频素材的 PCM 必须能被宿主解码
    for (const a of g.project.audioAssets || []) {
      const ch = decodeAssetPcm(a);
      if (!ch || ch.length === 0) { allOk = false; detail = `${id}:素材无 PCM`; break; }
    }
  }
  check('全部预设生成结果均为宿主合法工程（类型/轨道≤15/id 唯一/值域/非空）', allOk, detail);
}

// ----------------------------------------------------------------- 序列化往返不丢数据
{
  const g = amb.generateAmbientPiece({ presetId: 'phase-garden', seed: 'roundtrip', durationSec: 20, tempo: 90 });
  const json = serializeProject(g.project);
  const p2 = parseProject(json);
  const same =
    p2.tracks.length === g.project.tracks.length &&
    p2.clips.length === g.project.clips.length &&
    p2.audioAssets?.length === (g.project.audioAssets || []).length &&
    p2.ambient?.presetId === 'phase-garden' &&
    p2.tempo === 90;
  let notesEq = true;
  const orig = g.project.clips.flatMap((c) => c.notes);
  const back = p2.clips.flatMap((c) => c.notes);
  if (orig.length !== back.length) notesEq = false;
  else for (let i = 0; i < orig.length; i++) {
    if (orig[i].pitch !== back[i].pitch || orig[i].start !== back[i].start || orig[i].length !== back[i].length) { notesEq = false; break; }
  }
  check('序列化往返保留轨道/片段/素材/ambient元数据/音符', same && notesEq);
}

// ----------------------------------------------------------------- 同种子生成确定性
{
  const a = amb.generateAmbient({ presetId: 'sparse-fog', seed: 'same', durationSec: 30, tempo: 64 });
  const b = amb.generateAmbient({ presetId: 'sparse-fog', seed: 'same', durationSec: 30, tempo: 64 });
  const key = (p) => p.clips.flatMap((c) => c.notes).map((n) => `${n.pitch}:${n.start.toFixed(2)}:${n.length.toFixed(2)}`).join('|');
  check('同种子生成结果一致（音符序列相同）', key(a) === key(b) && key(a).length > 0);
}

// ----------------------------------------------------------------- 显式 tempo 生效
{
  const g = amb.generateAmbient({ presetId: 'spectral-weather', seed: 'tempo', durationSec: 15, tempo: 140 });
  check('显式 tempo 生效', g.tempo === 140, `=${g.tempo}`);
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;