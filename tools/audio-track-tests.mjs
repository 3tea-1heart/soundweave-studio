/**
 * 音频轨 DSP 测试：素材注册、音频声部、增益/偏移/截断、停止与重采样。
 * 用法：node tools/audio-track-tests.mjs
 *
 * 直接驱动 AudioWorklet 使用的同一个 StudioProcessor，逐 block 渲染后分析输出。
 */
import { StudioProcessor, defaultParams } from '../src/audio/studio-processor.js';

const SR = 48000;
globalThis.sampleRate = SR;

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function rms(arr, from = 0, to = arr.length) {
  let s = 0;
  const end = Math.min(to, arr.length);
  for (let i = from; i < end; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, end - from));
}
function peak(arr, from = 0, to = arr.length) {
  let p = 0;
  const end = Math.min(to, arr.length);
  for (let i = from; i < end; i++) p = Math.max(p, Math.abs(arr[i]));
  return p;
}

function makeProcessor(track = 3, setup = {}) {
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.postMessage = () => {};
  sp.receive({
    type: 'track',
    track,
    instrumentType: 'synth',
    params: defaultParams('synth'),
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    sendReverb: 0,
    sendDelay: 0,
    tone: 1,
    drive: 0,
    chorus: 0,
    ...setup,
  });
  // 跳过轨道参数平滑：发送量立即归零，避免混响尾音污染静音/截断判定
  const tr = sp.tracks[track];
  tr.volume = tr.volumeTarget = setup.volume ?? 1;
  tr.pan = tr.panTarget = setup.pan ?? 0;
  tr.sendRev = tr.sendRevTarget = 0;
  tr.sendDelay = tr.sendDelayTarget = 0;
  return sp;
}

function render(sp, blocks) {
  const total = blocks * 128;
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    sp.processBlock([l, r]);
    L.set(l, b * 128);
    R.set(r, b * 128);
  }
  return { L, R };
}

function sine(freq, seconds, rate = SR, amp = 0.3, phase = 0) {
  const frames = Math.round(seconds * rate);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((i / rate) * 2 * Math.PI * freq + phase) * amp;
  return out;
}

function register(sp, assetId, channels, rate = SR) {
  sp.receive({ type: 'asset', assetId, sampleRate: rate, channels });
}

function play(sp, opts) {
  sp.receive({
    type: 'audio',
    track: 3,
    assetId: 'sine',
    when: 0,
    offsetSec: 0,
    dur: 0.4,
    gain: 1,
    id: 'a1',
    src: 'transport',
    gen: 1,
    ...opts,
  });
}

// ---------------------------------------------------------------- 基本发声
{
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp);
  const { L, R } = render(sp, 160); // 0.427s
  const level = rms(L, 4800, 24000);
  check('音频片段发声', level > 0.05, `rms=${level.toFixed(4)}`);
  check('单声道素材左右相同', Math.abs(rms(L, 4800, 24000) - rms(R, 4800, 24000)) < 0.002);
  check('峰值受主总线限制', peak(L) <= 1, `peak=${peak(L).toFixed(3)}`);
  check('输出无 NaN', L.every((v) => Number.isFinite(v)) && R.every((v) => Number.isFinite(v)));
}
{
  // 增益：0.5 倍素材应约为 1 倍素材的一半（软限幅会略压缩，容差放宽）
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.4, SR, 0.2)]);
  play(sp);
  const full = rms(render(sp, 120).L, 4800, 16000);

  const sp2 = makeProcessor();
  register(sp2, 'sine', [sine(1000, 0.4, SR, 0.2)]);
  play(sp2, { gain: 0.5 });
  const half = rms(render(sp2, 120).L, 4800, 16000);
  const ratio = half / full;
  check('片段增益 0.5', ratio > 0.45 && ratio < 0.55, `ratio=${ratio.toFixed(3)}`);
}
{
  // 偏移：前 0.2s 静音 + 后 0.2s 正弦，从 0.2s 起播应立即有声
  const sp = makeProcessor();
  const ch = new Float32Array(SR * 0.4);
  ch.set(sine(1000, 0.2, SR, 0.3), SR * 0.2);
  register(sp, 'sine', [ch]);
  play(sp, { offsetSec: 0.2, dur: 0.15 });
  const { L } = render(sp, 80);
  check('片段源偏移', rms(L, 480, 4000) > 0.05, `rms=${rms(L, 480, 4000).toFixed(4)}`);
}
{
  // 截断：0.1s 后应静音（含 5ms 淡出）
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp, { dur: 0.1 });
  const { L } = render(sp, 160);
  const after = rms(L, 4800 + 400, 20000);
  const before = rms(L, 480, 3000);
  check('片段终点截断', after < 0.002, `after=${after.toFixed(5)}`);
  check('截断前有声', before > 0.05, `before=${before.toFixed(4)}`);
}
{
  // 素材先于片段结束 → 自然停止
  const sp = makeProcessor();
  register(sp, 'short', [sine(1000, 0.05)]);
  play(sp, { assetId: 'short', dur: 0.4 });
  const { L } = render(sp, 120);
  check('素材播完即停', rms(L, 4000, 15000) < 0.002, `rms=${rms(L, 4000, 15000).toFixed(5)}`);
}
{
  // 缺失素材：事件被忽略，不发声也不崩溃
  const sp = makeProcessor();
  play(sp, { assetId: 'missing' });
  const { L } = render(sp, 40);
  check('缺失素材静默跳过', rms(L) < 1e-6, `rms=${rms(L).toExponential(2)}`);
}

// ---------------------------------------------------------------- 立体声与声像
{
  const sp = makeProcessor();
  const l = sine(800, 0.4, SR, 0.3);
  const r = sine(800, 0.4, SR, 0.3, Math.PI);
  register(sp, 'sine', [l, r]);
  play(sp);
  const out = render(sp, 120);
  const from = 4800;
  const to = 16000;
  let maxDiff = 0;
  const limit = Math.min(to, out.L.length);
  for (let i = from; i < limit; i++) maxDiff = Math.max(maxDiff, Math.abs(out.L[i] + out.R[i]));
  check('立体声素材保持左右相位', maxDiff < 0.002, `maxDiff=${maxDiff.toFixed(4)}`);
}
{
  const sp = makeProcessor(3, { pan: -1 });
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp);
  const out = render(sp, 160);
  const l = rms(out.L, 9600, 18000);
  const r = rms(out.R, 9600, 18000);
  check('音频轨声像左移', l > 0.05 && r < 0.002, `L=${l.toFixed(4)} R=${r.toFixed(4)}`);
}
{
  // 自动化式音量变化：0.85 音量应小于 1.0
  const sp = makeProcessor(3, { volume: 0.5 });
  register(sp, 'sine', [sine(1000, 0.4, SR, 0.3)]);
  play(sp);
  const quiet = rms(render(sp, 160).L, 9600, 18000);

  const sp2 = makeProcessor(3, { volume: 1 });
  register(sp2, 'sine', [sine(1000, 0.4, SR, 0.3)]);
  play(sp2);
  const loud = rms(render(sp2, 160).L, 9600, 18000);
  check('音频轨音量跟随轨道音量', quiet < loud * 0.6, `${quiet.toFixed(4)} < ${loud.toFixed(4)}`);
}

// ---------------------------------------------------------------- 停止与打断
{
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp);
  render(sp, 40);
  sp.receive({ type: 'resetSource', src: 'transport', gen: 2 });
  const { L } = render(sp, 40);
  check('resetSource 淡出音频', rms(L, 300, L.length) < 0.002, `rms=${rms(L, 300, L.length).toFixed(5)}`);
  check('resetSource 释放后无声部', sp.tracks[3].audioVoices.length === 0);
  void L;
}
{
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp);
  render(sp, 40);
  sp.receive({ type: 'panic' });
  const { L } = render(sp, 40);
  // 总线 DC 阻断器会留下极短的衰减残余，允许 < 0.1% 满幅
  check('panic 立即清零音频', rms(L) < 1e-3, `rms=${rms(L).toExponential(2)}`);
  check('panic 清空音频声部', sp.tracks[3].audioVoices.length === 0);
}
{
  // 静音轨不发声，但片段仍会按时间结束
  const sp = makeProcessor(3, { mute: true });
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp);
  const { L } = render(sp, 80);
  check('静音音频轨不出声', rms(L) < 1e-6, `rms=${rms(L).toExponential(2)}`);
}

// ---------------------------------------------------------------- 重采样
{
  const rate = 44100;
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.5, rate)], rate);
  play(sp, { dur: 0.25 });
  const { L } = render(sp, 100);
  // 0.05s–0.2s 内统计零交叉，应接近 2 × 0.15 × 1000
  let crossings = 0;
  const from = Math.round(0.05 * SR);
  const to = Math.round(0.2 * SR);
  for (let i = from + 1; i < to; i++) {
    if (L[i - 1] <= 0 && L[i] > 0) crossings++;
  }
  check('44.1k 素材重采样到 48k', Math.abs(crossings - 150) <= 6, `crossings=${crossings}`);
  check('重采样后电平正常', rms(L, from, to) > 0.05, `rms=${rms(L, from, to).toFixed(4)}`);
}

// ---------------------------------------------------------------- 素材替换与多段
{
  const sp = makeProcessor();
  register(sp, 'sine', [sine(1000, 0.4)]);
  play(sp, { when: 0, dur: 0.1 });
  play(sp, { when: 0.2, dur: 0.1, id: 'a2' });
  const { L } = render(sp, 160);
  check('多段音频独立排程', rms(L, 800, 4000) > 0.03 && rms(L, 4800, 5600) < 0.02 && rms(L, 10000, 14000) > 0.03,
    `first=${rms(L, 800, 4000).toFixed(3)} gap=${rms(L, 4800, 5600).toFixed(3)} second=${rms(L, 10000, 14000).toFixed(3)}`);
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
