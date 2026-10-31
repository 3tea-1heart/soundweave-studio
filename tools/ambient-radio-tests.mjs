/**
 * Generative Ambient 模块（M5 Infinite Radio + checkpoint + capture）回归测试。
 * 用法：node tools/ambient-radio-tests.mjs
 * 覆盖：rolling horizon 增量推进、跨段无缝（无 NaN / beat 合法）、
 *       checkpoint/resume 确定性、capture 固化为合法工程、长时间 memory 有界、
 *       recurrence guard 的 history 有界、capture 可离线渲染。
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

const preset = amb.getPreset('sparse-fog');
const noteCount = (s) => Array.from(s.noteMap.values()).reduce((a, b) => a + b.length, 0);

// ----------------------------------------------------------------- 基础推进
{
  const s = amb.createRadioSession(preset, { seed: 'radio-basic' });
  const ev1 = amb.radioAdvance(s, 30);
  check('推进：产出事件', ev1.length > 0, `n=${ev1.length}`);
  check('推进：noteMap 非空', noteCount(s) > 0, `n=${noteCount(s)}`);
  check('推进：cursor 前进等于 30s', Math.abs(s.cursorBeat - s.tempo / 2) < 1e-6, `beat=${s.cursorBeat.toFixed(2)}`);
  check('推进：无 NaN', allFinite({ ev1, notes: Array.from(s.noteMap.values()) }));
  // 各 agent note.start 单调（同轨内递增）
  let mono = true;
  for (const arr of s.noteMap.values()) {
    for (let i = 1; i < arr.length; i++) if (arr[i].start < arr[i - 1].start) mono = false;
  }
  check('推进：同轨 note 起点单调', mono);
  const allNotes = Array.from(s.noteMap.values()).flat();
  check('推进：音符字段合法', allNotes.every((n) => n.start >= 0 && n.start < s.cursorBeat && n.length > 0 && n.velocity >= 0.05 && n.velocity <= 1 && Number.isInteger(n.pitch)));
  check('推进：history 有界（recurrence guard）', s.history.length <= 128, `len=${s.history.length}`);
}

// ----------------------------------------------------------------- checkpoint/resume 确定性
{
  // 连续运行
  const a = amb.createRadioSession(preset, { seed: 'radio-resume' });
  amb.radioAdvance(a, 10);
  amb.radioAdvance(a, 10);
  // 中途 checkpoint 再 resume
  const b = amb.createRadioSession(preset, { seed: 'radio-resume' });
  amb.radioAdvance(b, 10);
  const st = amb.radioExportState(b);
  const b2 = amb.radioImportState(JSON.parse(JSON.stringify(st)));
  amb.radioAdvance(b2, 10);
  check('恢复：连续 vs resume 的 noteMap 一致', JSON.stringify(Array.from(a.noteMap.entries())) === JSON.stringify(Array.from(b2.noteMap.entries())));
  check('恢复：elapsedSec 一致', a.elapsedSec === b2.elapsedSec);
  check('恢复：globalSeq 一致', a.globalSeq === b2.globalSeq);
  check('恢复：cursorBeat 一致', a.cursorBeat === b2.cursorBeat);
  check('恢复：macroTonic 一致', a.macroTonic === b2.macroTonic);
}

// ----------------------------------------------------------------- capture 固化
{
  const s = amb.createRadioSession(preset, { seed: 'radio-capture' });
  amb.radioAdvance(s, 10);
  amb.radioAdvance(s, 10);
  amb.radioAdvance(s, 10);
  amb.radioAdvance(s, 10);
  const proj = amb.radioCaptureLast(s, 20);
  const notes = proj.clips.flatMap((c) => c.notes);
  const totalBeats = s.cursorBeat - (s.cursorBeat - s.tempo * 20 / 60);
  check('捕获：有音符且相对化（start≥0）', notes.length > 0 && notes.every((n) => n.start >= 0), `n=${notes.length}`);
  check('捕获：工程无 NaN', allFinite(proj));
  check('捕获：轨道数匹配', proj.tracks.length === preset.agents.length + (preset.texture?.length ?? 0), `tracks=${proj.tracks.length}`);
  check('捕获：有纹理轨（非 MIDI）', proj.tracks.some((t) => t.kind === 'audio'));
  // 可离线渲染（复用宿主 StudioProcessor）
  const rendered = amb.renderAmbient(proj, { sampleRate: 22050 });
  let audible = false;
  for (const ch of rendered.channels) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 1e-4) { audible = true; break; }
  check('捕获：可离线渲染且可闻', rendered.channels.length === 2 && audible && allFinite({ channels: rendered.channels }));
}

// ----------------------------------------------------------------- 长时间 + memory 有界
{
  const s = amb.createRadioSession(preset, { seed: 'radio-long' });
  s.retentionSec = 20; // 缩短保留窗，验证裁剪
  for (let i = 0; i < 12; i++) amb.radioAdvance(s, 10); // 共 120s
  const total = noteCount(s);
  check('长时间：无事件爆炸', total > 0 && total < 5000, `n=${total}`);
  check('长时间：无 NaN', allFinite({ scene: s.scene, notes: Array.from(s.noteMap.values()) }));
  const retentionBeat = s.cursorBeat - (s.retentionSec * s.tempo) / 60;
  let within = true;
  for (const arr of s.noteMap.values()) for (const n of arr) if (n.start < retentionBeat - 1e-6) within = false;
  check('长时间：memory 有界（notes 均在保留窗内）', within);
  check('长时间：scene 有界', s.scene.length < 2000, `scene=${s.scene.length}`);
  check('长时间：history 有界', s.history.length <= 128);
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;