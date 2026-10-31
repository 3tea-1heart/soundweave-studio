/**
 * Web MIDI 输入逻辑回归测试。
 * 用法：node tools/midi-tests.mjs
 * 直接调用与浏览器相同的 MidiInput，向它喂 MIDI 字节流，检查音符、延音踏板与全部停音。
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

const mod = await loadTs(join(ROOT, 'src/core/midi-input.ts'));
const learn = await loadTs(join(ROOT, 'src/core/midi-learn.ts'));

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

function harness() {
  const log = [];
  const expression = [];
  const midi = new mod.MidiInput({
    noteOn: (pitch, velocity) => log.push(['on', pitch, Number(velocity.toFixed(3))]),
    noteOff: (pitch) => log.push(['off', pitch]),
    bend: (v) => expression.push(['bend', Number(v.toFixed(4))]),
    pressure: (v) => expression.push(['pressure', Number(v.toFixed(4))]),
    control: (cc, v) => expression.push(['cc', cc, v]),
    status: () => {},
  });
  const send = (bytes) => midi.onMessage(new Uint8Array(bytes));
  return { midi, log, expression, send };
}

// ---------------------------------------------------------------- 力度映射
{
  check('力度：127 → 1', mod.midiVelocity(127) === 1);
  check('力度：64 → 约 0.504', Math.abs(mod.midiVelocity(64) - 64 / 127) < 1e-9);
  check('力度：1 → 下限 0.05', mod.midiVelocity(1) === 0.05);
}

// ---------------------------------------------------------------- 音符
{
  const h = harness();
  h.send([0x90, 60, 100]);
  check('音符：Note On 触发一次', h.log.length === 1 && h.log[0][0] === 'on' && h.log[0][1] === 60);
  h.send([0x90, 60, 100]);
  check('音符：同一音重复 Note On 不重复起音', h.log.length === 1);
  h.send([0x80, 60, 0]);
  check('音符：Note Off 释放', h.log.length === 2 && h.log[1][0] === 'off' && h.log[1][1] === 60);
  h.send([0x90, 61, 0]);
  check('音符：力度 0 的 Note On 视为 Note Off', h.log.length === 2);
  h.send([0x80, 62, 0]);
  check('音符：未按下的 Note Off 被忽略', h.log.length === 2);
}

// ---------------------------------------------------------------- 延音踏板
{
  const h = harness();
  h.send([0xb0, 64, 127]);
  h.send([0x90, 64, 90]);
  h.send([0x80, 64, 0]);
  check('踏板：踩下时松键不立即停音', h.log.filter((e) => e[0] === 'off').length === 0);
  h.send([0xb0, 64, 0]);
  check('踏板：抬起后释放被延音的音', h.log.filter((e) => e[0] === 'off').length === 1 && h.log.at(-1)[1] === 64);
}
{
  const h = harness();
  h.send([0x90, 67, 90]);
  h.send([0x90, 64, 90]);
  h.send([0x80, 67, 0]);
  check('踏板：未踩踏板时正常松键', h.log.filter((e) => e[0] === 'off').length === 1);
  h.send([0x80, 64, 0]);
  check('踏板：第二个音照常松键', h.log.filter((e) => e[0] === 'off').length === 2);
}
{
  const h = harness();
  h.send([0xb0, 64, 127]);
  h.send([0x90, 70, 80]);
  h.send([0x80, 70, 0]);
  h.send([0x90, 70, 80]);
  h.send([0x80, 70, 0]);
  check('踏板：延音中重按同一音不重复起音', h.log.filter((e) => e[0] === 'on').length === 1);
  h.send([0xb0, 64, 0]);
  check('踏板：重按后抬起踏板只释放一次', h.log.filter((e) => e[0] === 'off').length === 1);
}

// ---------------------------------------------------------------- 全部停音
{
  const h = harness();
  h.send([0xb0, 64, 127]);
  h.send([0x90, 60, 90]);
  h.send([0x90, 64, 90]);
  h.send([0x80, 60, 0]);
  h.send([0xb0, 123, 0]);
  check('CC123：释放所有正在发声的音', h.log.filter((e) => e[0] === 'off').length === 2);
  check('CC123：踏板状态被清除', h.log.filter((e) => e[0] === 'off').length === 2);
}
{
  const h = harness();
  h.send([0x90, 60, 90]);
  h.midi.releaseAll();
  check('releaseAll：停止运输/切窗口时释放全部音', h.log.filter((e) => e[0] === 'off').length === 1);
}

// ---------------------------------------------------------------- 弯音 / 触后 / CC
{
  const h = harness();
  h.send([0xe0, 0x00, 0x40]);
  check('弯音：中心 8192 → 0', h.expression.at(-1)[0] === 'bend' && h.expression.at(-1)[1] === 0);
  h.send([0xe0, 0x7f, 0x7f]);
  check('弯音：上限 16383 → 约 +1', Math.abs(h.expression.at(-1)[1] - 0.9999) < 0.001);
  h.send([0xe0, 0x00, 0x00]);
  check('弯音：下限 0 → -1', h.expression.at(-1)[1] === -1);
  h.send([0xe0, 0x01, 0x40]);
  const lowBit = h.expression.at(-1)[1];
  check('弯音：低 7 位参与 14-bit 计算', lowBit > 0 && lowBit < 0.01);
}
{
  const h = harness();
  h.send([0xd0, 64]);
  check('触后：通道压力 64 → 约 0.5', Math.abs(h.expression.at(-1)[1] - 64 / 127) < 0.001);
  h.send([0xa0, 60, 100]);
  check('触后：复音压力 100 → 约 0.79', Math.abs(h.expression.at(-1)[1] - 100 / 127) < 0.001);
}
{
  const h = harness();
  h.send([0xb0, 7, 100]);
  check('CC：未被内置占用的控制器转发给 MIDI Learn', h.expression.at(-1)[0] === 'cc' && h.expression.at(-1)[1] === 7 && h.expression.at(-1)[2] === 100);
  const ccBefore = h.expression.filter((e) => e[0] === 'cc').length;
  h.send([0xb0, 64, 127]);
  h.send([0xb0, 123, 0]);
  check('CC：踏板与 CC123 不进入 MIDI Learn', h.expression.filter((e) => e[0] === 'cc').length === ccBefore);
}

// ---------------------------------------------------------------- 其它消息
{
  const h = harness();
  h.send([0xe0, 0, 64]);
  h.send([0xb0, 7, 100]);
  h.send([0xa0, 60, 40]);
  check('其它：弯音/音量 CC/触后不误触发音符', h.log.length === 0);
}

// ---------------------------------------------------------------- MIDI Learn 映射
{
  const track = { instrument: { type: 'synth' } };
  check('映射：合成器 cutoff 范围 100–6000', learn.targetRange(track, { kind: 'param', key: 'cutoff' }).max === 6000);
  check('映射：鼓机 punch 可用', !!learn.targetRange({ instrument: { type: 'drum' } }, { kind: 'param', key: 'punch' }));
  check('映射：切换音源后不适用返回 null', learn.targetRange(track, { kind: 'param', key: 'punch' }) === null);
  check('映射：轨道效果 volume 范围 0–1', learn.targetRange(track, { kind: 'fx', key: 'volume' }).max === 1);
  check('映射：未知效果返回 null', learn.targetRange(track, { kind: 'fx', key: 'nope' }) === null);
  check('映射：标签取参数名', learn.targetLabel(track, { kind: 'param', key: 'cutoff' }) === '滤波截止');

  check('映射：合法条目通过校验', !!learn.sanitizeMapping({ cc: 7, kind: 'param', key: 'cutoff', min: 100, max: 6000 }));
  check('映射：CC 越界被拒绝', learn.sanitizeMapping({ cc: 128, kind: 'param', key: 'cutoff', min: 1, max: 2 }) === null);
  check('映射：负 CC 被拒绝', learn.sanitizeMapping({ cc: -1, kind: 'param', key: 'cutoff', min: 1, max: 2 }) === null);
  check('映射：未知类型被拒绝', learn.sanitizeMapping({ cc: 7, kind: 'other', key: 'x', min: 1, max: 2 }) === null);
  check('映射：空 key 被拒绝', learn.sanitizeMapping({ cc: 7, kind: 'param', key: '  ', min: 1, max: 2 }) === null);
  check('映射：min/max 反向被拒绝', learn.sanitizeMapping({ cc: 7, kind: 'param', key: 'x', min: 2, max: 1 }) === null);
  check('映射：非数字范围被拒绝', learn.sanitizeMapping({ cc: 7, kind: 'param', key: 'x', min: '1', max: 2 }) === null);

  const a = { cc: 7, kind: 'param', key: 'cutoff', min: 100, max: 6000 };
  const b = { cc: 21, kind: 'fx', key: 'drive', min: 0, max: 1 };
  let list = learn.upsertMapping([], a);
  check('映射：新增返回一条', list.length === 1);
  list = learn.upsertMapping(list, b);
  check('映射：不同 CC 可并列', list.length === 2);
  list = learn.upsertMapping(list, { ...a, cc: 8 });
  check('映射：同一目标换 CC 只保留最新', list.length === 2 && list.find((m) => m.key === 'cutoff').cc === 8);
  list = learn.upsertMapping(list, { ...b, cc: 8 });
  check('映射：同一 CC 覆盖旧目标', list.length === 1 && list[0].cc === 8 && list[0].key === 'drive');
  check('映射：按 CC 查找', learn.mappingFor(list, 8)?.key === 'drive');
  check('映射：删除后为空', learn.removeMapping(list, 8).length === 0);

  check('映射：CC 0 → 下限', learn.applyMidiRaw(a, 0) === 100);
  check('映射：CC 127 → 上限', learn.applyMidiRaw(a, 127) === 6000);
  check('映射：CC 64 → 近似中点', Math.abs(learn.applyMidiRaw(a, 64) - 3000) < 125);
  check('映射：越界原始值被夹紧', learn.applyMidiRaw(a, 200) === 6000);

  check('弯音换算：0 → -1', learn.bendValue(0) === -1);
  check('弯音换算：8192 → 0', learn.bendValue(8192) === 0);
  check('弯音换算：16383 → 接近 +1', Math.abs(learn.bendValue(16383) - 1) < 0.001);
}

// ---------------------------------------------------------------- 持久化
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const a = { cc: 7, kind: 'param', key: 'cutoff', min: 100, max: 6000 };
  learn.saveMidiMappings([a]);
  const loaded = learn.loadMidiMappings();
  check('持久化：写入后可读回', loaded.length === 1 && loaded[0].cc === 7);
  mem.set('soundweave.midi-map.v1', '{not json');
  check('持久化：损坏内容返回空', learn.loadMidiMappings().length === 0);
  mem.set('soundweave.midi-map.v1', JSON.stringify([a, { ...a, cc: 7, key: 'other' }, { cc: 300, kind: 'param', key: 'x', min: 0, max: 1 }]));
  const dedup = learn.loadMidiMappings();
  check('持久化：重复 CC 与坏条目被过滤', dedup.length === 1 && dedup[0].key === 'cutoff');
  delete globalThis.localStorage;
}

// ---------------------------------------------------------------- 释放表情
{
  const h = harness();
  h.send([0xe0, 0x7f, 0x7f]);
  h.send([0xd0, 100]);
  h.midi.releaseAll();
  check('releaseAll：弯音与触后归零', h.expression.at(-2)[0] === 'bend' && h.expression.at(-2)[1] === 0 && h.expression.at(-1)[0] === 'pressure' && h.expression.at(-1)[1] === 0);
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
