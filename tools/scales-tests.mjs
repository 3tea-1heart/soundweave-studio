/**
 * 音阶与和弦建议回归测试。
 * 用法：node tools/scales-tests.mjs
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

const scales = await loadTs(join(ROOT, 'src/core/scales.ts'));

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

const major = scales.scaleById('major').intervals;
const minor = scales.scaleById('minor').intervals;
const harmonicMinor = scales.scaleById('harmonic-minor').intervals;

check('音阶：大调音程', major.join(',') === '0,2,4,5,7,9,11');
check('音阶：未知 id 回退大调', scales.scaleById('nope').id === 'major');

// C 大调七和弦符号
{
  const chords = scales.diatonicChords(0, major, true);
  const sym = chords.map((c) => c.symbol).join(',');
  check('和弦：C 大调七和弦符号', sym === 'Cmaj7,Dm7,Em7,Fmaj7,G7,Am7,Bm7\u266D5', sym);
  const num = chords.map((c) => c.numeral).join(',');
  check('和弦：罗马级数', num === 'I,ii,iii,IV,V,vi,vii\u00B0', num);
}

// C 大调三和弦
{
  const tri = scales.diatonicChords(0, major, false);
  const sym = tri.map((c) => c.symbol).join(',');
  check('和弦：C 大调三和弦符号', sym === 'C,Dm,Em,F,G,Am,Bdim', sym);
  check('和弦：三和弦无七音', tri.every((c) => !c.seventh && c.tones.length === 3));
}

// C 自然小调（降号拼写）
{
  const chords = scales.diatonicChords(0, minor, true);
  const sym = chords.map((c) => c.symbol).join(',');
  check('和弦：C 自然小调七和弦（降号拼写）', sym === 'Cm7,Dm7\u266D5,E\u266Dmaj7,Fm7,Gm7,A\u266Dmaj7,B\u266D7', sym);
}

// C 和声小调：vii°（Bdim7，减七）
{
  const chords = scales.diatonicChords(0, harmonicMinor, true);
  check('和弦：和声小调 vii° 为减七和弦', chords[6].symbol === 'Bdim7', chords[6].symbol);
}

// 和弦性质（显式音级集合）
{
  check('和弦：大三符号', scales.chordQuality(0, [0, 4, 7]) === '');
  check('和弦：小三符号', scales.chordQuality(0, [0, 3, 7]) === 'm');
  check('和弦：大七符号', scales.chordQuality(0, [0, 4, 7, 11]) === 'maj7');
  check('和弦：属七符号', scales.chordQuality(7, [7, 11, 2, 5]) === '7');
  check('和弦：半减七（小七降五）', scales.chordQuality(11, [11, 2, 5, 9]) === 'm7\u266D5');
  check('和弦：减七', scales.chordQuality(11, [11, 2, 5, 8]) === 'dim7');
  check('和弦：音名升号默认', scales.noteName(6) === 'F#');
}

// 实时建议：当前音集匹配覆盖最多的和弦
{
  const chords = scales.diatonicChords(0, major, true);
  const c = scales.suggestChord(chords, [60, 64, 67]); // C E G
  check('建议：C E G → Cmaj7', c && c.symbol === 'Cmaj7', c && c.symbol);
  const d = scales.suggestChord(chords, [62, 65, 69]); // D F A
  check('建议：D F A → Dm7', d && d.symbol === 'Dm7', d && d.symbol);
  const none = scales.suggestChord(chords, []);
  check('建议：空音集返回 null', none === null);
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;