/**
 * 五线谱记谱（音高 → 自然音名/升降/八度/步进）回归测试。
 * 用法：node tools/notation-tests.mjs
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

const notation = await loadTs(join(ROOT, 'src/core/notation.ts'));

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

check('记谱：中央 C（60）→ C4 step 0', notation.spellPitch(60).name === 'C4' && notation.spellPitch(60).step === 0);
check('记谱：E4（64）→ step 2（下加一线上方）', notation.spellPitch(64).name === 'E4' && notation.spellPitch(64).step === 2);
check('记谱：F#（66）→ F#4 升号', (() => { const s = notation.spellPitch(66); return s.name === 'F#4' && s.letter === 3 && s.alter === 1; })());
check('记谱：B3（59）→ step -1', (() => { const s = notation.spellPitch(59); return s.name === 'B3' && s.octave === 3 && s.step === -1; })());
check('记谱：C5（72）→ step 7', notation.spellPitch(72).step === 7 && notation.spellPitch(72).octave === 5);
check('记谱：C#（61）→ 升号', notation.spellPitch(61).alter === 1 && notation.spellPitch(61).name === 'C#4');

// 自然音级步进连续：C4..C5 依次为 0..7
const steps = [60, 62, 64, 65, 67, 69, 71, 72].map((p) => notation.spellPitch(p).step);
check('记谱：C 大调逐级步进 0..7', steps.join(',') === '0,1,2,3,4,5,6,7', steps.join(','));

check('记谱：升降号字符', notation.alterMark(1) === '\u266F' && notation.alterMark(-1) === '\u266D' && notation.alterMark(0) === '');
check('记谱：双重升号', notation.alterMark(2) === '\u266F\u266F');

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;