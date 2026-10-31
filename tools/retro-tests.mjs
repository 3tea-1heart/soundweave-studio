/**
 * 回溯录制纯函数回归测试。
 * 用法：node tools/retro-tests.mjs
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

const retro = await loadTs(join(ROOT, 'src/core/retro.ts'));

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

function ev(pitch, start, length, velocity = 0.8) {
  return { pitch, start, length, velocity, articulation: 'normal' };
}

// ---------------------------------------------------------------- 缓冲追加
{
  const buf = [];
  retro.pushRetro(buf, ev(60, 0, 0.5));
  retro.pushRetro(buf, ev(64, 1, 0.5));
  check('缓冲：按序追加', buf.length === 2 && buf[0].pitch === 60 && buf[1].pitch === 64);
  retro.pushRetro(buf, ev(65, 2, 0.01));
  check('缓冲：超短音符时长钳到 0.0625', Math.abs(buf[2].length - 0.0625) < 1e-9);
  for (let i = 0; i < 70; i++) retro.pushRetro(buf, ev(66, i, 0.25));
  check('缓冲：滚动上限 64', buf.length === 64 && buf[0].pitch === 66, String(buf.length));
}

// ---------------------------------------------------------------- 写回转换
{
  let seq = 0;
  const idGen = () => `n${++seq}`;
  const buf = [ev(60, 0.1, 0.4), ev(62, 1.9, 0.8), ev(64, 5.0, 1.0), ev(67, 20, 0.5)];
  // 片段：start=0, offset=0, length=8, snap=0.25
  const notes = retro.retroToNotes(buf, 0, 0, 8, 0.25, idGen);
  const pitches = notes.map((n) => n.pitch).join(',');
  check('写回：范围过滤（20→越界被丢弃）', pitches === '60,62,64', pitches);
  check('写回：起始拍吸附到 0.25', notes.map((n) => n.start).join(',') === '0,2,5', notes.map((n) => n.start).join(','));
  check('写回：时长按 1/16 取整', Math.abs(notes[0].length - 0.375) < 1e-9, String(notes[0].length));
  check('写回：生成唯一 ID', notes.length === 3 && new Set(notes.map((n) => n.id)).size === 3);
}

// ---------------------------------------------------------------- 越界裁剪
{
  let seq = 0;
  const idGen = () => `m${++seq}`;
  // 片段 start=0, offset=0, length=2；音符 1.75 开始长 1，应裁到片段结尾
  const notes = retro.retroToNotes([ev(60, 1.75, 1.0)], 0, 0, 2, 0.25, idGen);
  check('写回：时长越界裁到片段结尾', notes.length === 1 && Math.abs(notes[0].length - 0.25) < 1e-9, String(notes[0]?.length));
  // offset 参与换算：clip.start=4, offset=1, local = (start - 4 + 1)
  const notes2 = retro.retroToNotes([ev(60, 4.0, 0.5)], 4, 1, 4, 0.25, idGen);
  check('写回：offset 参与局部拍换算', notes2.length === 1 && notes2[0].start === 1, String(notes2[0]?.start));
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;