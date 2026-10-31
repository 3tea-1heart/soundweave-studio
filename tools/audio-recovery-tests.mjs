/**
 * 音频引擎自愈回归测试（长时间使用后“界面在播但没声音”）。
 * 用法：node tools/audio-recovery-tests.mjs
 *
 * 覆盖：坏时间戳堵塞事件队列、NaN 力度/参数污染滤波器、长反馈链路 NaN、
 * 渲染异常自愈与上报、事件队列上限、长会话输出稳定。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SR = 48000;

// Worklet 包装层只在这些全局存在时注册，先注入再动态 import
const workletMessages = [];
class FakeAudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, postMessage: (m) => workletMessages.push(m) };
  }
}
globalThis.AudioWorkletProcessor = FakeAudioWorkletProcessor;
globalThis.sampleRate = SR;
let RegisteredWorklet = null;
globalThis.registerProcessor = (_name, cls) => {
  RegisteredWorklet = cls;
};

const { StudioProcessor, defaultParams } = await import('../src/audio/studio-processor.js');

async function loadTs(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(url);
}

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

function setup() {
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.postMessage = () => {};
  sp.receive({
    type: 'track', track: 0, instrumentType: 'synth', params: defaultParams('synth'),
    volume: 0.85, pan: 0, mute: false, solo: false,
    sendReverb: 0.2, sendDelay: 0.05, tone: 0.9, drive: 0.05, chorus: 0,
  });
  sp.receive({ type: 'master', volume: 1 });
  return sp;
}

function render(sp, seconds) {
  const total = Math.floor(seconds * SR);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  for (let b = 0; b < Math.ceil(total / 128); b++) {
    bl.fill(0);
    br.fill(0);
    sp.processBlock([bl, br]);
    const offset = b * 128;
    for (let i = 0; i < 128 && offset + i < total; i++) {
      L[offset + i] = bl[i];
      R[offset + i] = br[i];
    }
  }
  return { L, R };
}

function peakBetween(x, fromSec, toSec) {
  let peak = 0;
  const start = Math.max(0, Math.floor(fromSec * SR));
  const end = Math.min(x.L.length, Math.floor(toSec * SR));
  for (let i = start; i < end; i++) {
    const a = Math.max(Math.abs(x.L[i]), Math.abs(x.R[i]));
    if (Number.isFinite(a) && a > peak) peak = a;
  }
  return peak;
}

// 1) 非有限时间戳不能卡住事件队列
{
  const sp = setup();
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: 0.8, when: NaN, dur: 0.4, id: 'bad' });
  sp.receive({ type: 'note', track: 0, pitch: 62, velocity: 0.8, when: 0.2, dur: 0.4, id: 'good' });
  const x = render(sp, 1.2);
  check('坏时间戳不再堵塞事件队列', sp.events.length === 0, `队列残留 ${sp.events.length}`);
  check('坏时间戳之后的音符正常发声', peakBetween(x, 0.15, 0.7) > 0.2, `${peakBetween(x, 0.15, 0.7)}`);
}

// 2) NaN 力度不得污染轨道滤波器状态
{
  const sp = setup();
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: NaN, when: 0.05, dur: 0.4, id: 'bad' });
  sp.receive({ type: 'note', track: 0, pitch: 64, velocity: 0.8, when: 0.6, dur: 0.4, id: 'good' });
  const x = render(sp, 1.4);
  check('NaN 力度不再污染滤波器状态', Number.isFinite(sp.tracks[0].lpL) && Number.isFinite(sp.dcL.y1));
  check('NaN 力度之后仍能发声', peakBetween(x, 0.6, 1.0) > 0.2, `${peakBetween(x, 0.6, 1.0)}`);
}

// 3) NaN/undefined 参数被丢弃，非法值不能写进平滑目标
{
  const sp = setup();
  sp.receive({ type: 'track', track: 0, params: { cutoff: NaN, resonance: undefined, index: Infinity } });
  const p = sp.tracks[0];
  check(
    'NaN 参数不进入目标值',
    Number.isFinite(p.target.cutoff) && Number.isFinite(p.target.resonance) && !('index' in p.target),
    JSON.stringify({ cutoff: p.target.cutoff, resonance: p.target.resonance, hasIndex: 'index' in p.target }),
  );
  sp.receive({ type: 'track', track: 0, params: { cutoff: 1800 } });
  render(sp, 0.3);
  check('后续合法参数仍能生效', Math.abs(p.target.cutoff - 1800) < 1e-6, String(p.target.cutoff));
}

// 4) 长反馈链路被污染后自动重建
{
  const sp = setup();
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: 0.8, when: 0.1, dur: 1.2, id: 'n1' });
  render(sp, 0.2);
  const before = sp.recoveries;
  sp.reverb.outL = NaN;
  sp.delay.lpL = NaN;
  sp.dcL.y1 = NaN;
  const x = render(sp, 1.2);
  check('总线 NaN 状态被自动重建', sp.recoveries > before, `${before} → ${sp.recoveries}`);
  check('重建后输出恢复有声且为有限值', peakBetween(x, 0.4, 1.2) > 0.2, `${peakBetween(x, 0.4, 1.2)}`);
}

// 5) recover() 清空声部与事件，供工作线程异常后调用
{
  const sp = setup();
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: 0.8, when: 0.05, dur: 4, id: 'n1' });
  sp.receive({ type: 'note', track: 0, pitch: 62, velocity: 0.8, when: 5, dur: 0.4, id: 'n2' });
  render(sp, 0.3);
  sp.recover();
  check('recover 清空全部声部', sp.tracks.every((t) => t.voices.length === 0 && t.audioVoices.length === 0));
  check('recover 清空事件队列', sp.events.length === 0);
  sp.receive({ type: 'note', track: 0, pitch: 64, velocity: 0.8, when: 0.3, dur: 0.4, id: 'n3' });
  const x = render(sp, 0.8);
  check('recover 之后继续正常发声', peakBetween(x, 0.29, 0.7) > 0.2, `${peakBetween(x, 0.29, 0.7)}`);
}

// 6) 事件队列有上限，不会无限增长
{
  const sp = setup();
  for (let i = 0; i < 9000; i++) {
    sp.events.push({ frame: 1000 + i, kind: 'note', track: 0, pitch: 60, velocity: 0.7, id: `n${i}` });
  }
  sp.sortEvents();
  check('事件队列被限制在 8192 条以内', sp.events.length <= 8192, String(sp.events.length));
}

// 7) Worklet 渲染异常：自愈、上报、节点继续工作
{
  check('Worklet 已注册（测试前置）', typeof RegisteredWorklet === 'function');
  const w = new RegisteredWorklet();
  const out = [new Float32Array(128), new Float32Array(128)];
  workletMessages.length = 0;
  w.sp.tracks[0].renderBlock = () => {
    throw new Error('模拟渲染异常');
  };
  w.process([], [out]);
  const errMsg = workletMessages.find((m) => m && m.type === 'error');
  check('渲染异常被捕获并上报', !!errMsg, JSON.stringify(workletMessages));
  check('异常块输出静音而不是残留旧数据', out[0].every((v) => v === 0) && out[1].every((v) => v === 0));
  delete w.sp.tracks[0].renderBlock;
  w.port.onmessage({
    data: {
      type: 'track', track: 0, instrumentType: 'synth', params: defaultParams('synth'),
      volume: 0.85, pan: 0, mute: false, solo: false, sendReverb: 0.2, sendDelay: 0, tone: 0.9, drive: 0.05, chorus: 0,
    },
  });
  w.port.onmessage({ data: { type: 'note', track: 0, pitch: 60, velocity: 0.8, when: 0, dur: 0.6, id: 'after' } });
  let peak = 0;
  for (let b = 0; b < 200; b++) {
    out[0].fill(0);
    out[1].fill(0);
    w.process([], [out]);
    for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(out[0][i]));
  }
  check('异常后节点继续发声', peak > 0.2, String(peak));
}

// 8) 长会话：持续循环播放 20 秒，输出稳定且无事件堆积
{
  const sp = setup();
  for (let i = 0; i < 80; i++) {
    sp.receive({
      type: 'note', track: 0, pitch: 60 + (i % 12), velocity: 0.75,
      when: i * 0.25, dur: 0.2, id: `loop${i}`, src: 'transport', gen: 1,
    });
  }
  const x = render(sp, 20);
  check('长会话输出保持有声', peakBetween(x, 18, 20) > 0.2, `${peakBetween(x, 18, 20)}`);
  check('长会话事件队列收敛', sp.events.length === 0, String(sp.events.length));
  check('长会话声部数量受控', sp.tracks[0].voices.length <= 24, String(sp.tracks[0].voices.length));
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
