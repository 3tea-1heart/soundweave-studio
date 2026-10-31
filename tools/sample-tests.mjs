/**
 * 采样音源回归测试：清单解析、WAV 读取、根音/变调发声、力度分层、循环、回退。
 * 用法：node tools/sample-tests.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
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

/** 用 fs 支撑 fetch，让真正的 loader（sample-bank.ts）在 Node 里跑起来 */
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^samples\//, '');
  const file = path.join('public', 'samples', rel);
  if (!fs.existsSync(file)) return new Response('', { status: 404 });
  return new Response(fs.readFileSync(file), { status: 200 });
};

const bundled = await build({
  stdin: {
    contents: [
      "export * from './src/core/sample-bank.ts';",
      "export * from './src/core/session.ts';",
      "export * from './src/core/project.ts';",
      "export * from './src/core/tempo.ts';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
const sb = await import(url);

const banks = sb.SAMPLE_BANKS;
check('清单包含四个采样库', banks.length === 4, banks.map((b) => b.id).join(','));
for (const bank of banks) {
  check(`库 ${bank.id} 有采样与授权信息`, bank.samples.length > 0 && !!bank.license, `${bank.samples.length} 个 · ${bank.license}`);
}

const piano = sb.bankById('piano-kw');
check('钢琴包含强弱两层', piano && new Set(piano.samples.map((s) => s.velMin)).size >= 2, piano ? `${piano.samples.length}` : 'missing');
check('钢琴覆盖低音到高音', piano && Math.min(...piano.samples.map((s) => s.pitch)) <= 24 && Math.max(...piano.samples.map((s) => s.pitch)) >= 96);

const loaded = {};
for (const id of ['piano-kw', 'guitar-fss', 'bass-yr', 'drums-muldjord']) {
  loaded[id] = await sb.fetchBank(sb.bankById(id));
}

function makeProcessor(bankId, type, setup = {}) {
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.postMessage = () => {};
  sp.receive({
    type: 'track',
    track: 3,
    instrumentType: type,
    params: defaultParams(type),
    sampleBank: bankId,
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
  const tr = sp.tracks[3];
  tr.volume = tr.volumeTarget = 1;
  tr.sendRev = tr.sendRevTarget = 0;
  tr.sendDelay = tr.sendDelayTarget = 0;
  tr.toneS = tr.toneLP = 1;
  tr.driveS = 0;
  tr.chorusS = 0;
  return sp;
}

function sendBank(sp, bank) {
  sp.receive({
    type: 'sbank',
    bankId: bank.id,
    kind: bank.kind,
    sampleRate: bank.sampleRate,
    samples: bank.samples,
  });
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

function peak(arr, from = 0, to = arr.length) {
  let p = 0;
  for (let i = from; i < Math.min(to, arr.length); i++) p = Math.max(p, Math.abs(arr[i]));
  return p;
}
function zcr(arr, from = 0, to = arr.length) {
  let n = 0;
  for (let i = from + 1; i < Math.min(to, arr.length); i++) if ((arr[i - 1] < 0) !== (arr[i] < 0)) n++;
  return n / Math.max(1, Math.min(to, arr.length) - from);
}

function play(sp, pitch, velocity = 0.8, dur = 0.5, track = 3) {
  sp.receive({ type: 'note', track, pitch, velocity, when: 0, dur, id: `n${pitch}${velocity}`, src: 'transport', gen: 1 });
}

// ---------------------------------------------------------------- 钢琴采样发声
{
  const sp = makeProcessor('piano-kw', 'piano');
  sendBank(sp, loaded['piano-kw']);
  play(sp, 60, 0.85, 1.0);
  const { L } = render(sp, 24);
  check('钢琴采样发声非静音', peak(L) > 0.05, `peak=${peak(L).toFixed(3)}`);
  check('钢琴采样无 NaN', L.every((v) => Number.isFinite(v)));

  const voiced = sp.tracks[3].voices[0];
  check('钢琴走的是采样声部', voiced && voiced.constructor.name === 'SampleVoice', voiced && voiced.constructor.name);
  check('钢琴低力度选低层、高力度选高层', (() => {
    const tr = sp.tracks[3];
    const soft = tr.pickSample(60, 0.2);
    const loud = tr.pickSample(60, 0.95);
    return soft && loud && soft !== loud && soft.velMax < loud.velMax;
  })(), '力度分层');
}

// ---------------------------------------------------------------- 变调方向
{
  const up = makeProcessor('piano-kw', 'piano');
  sendBank(up, loaded['piano-kw']);
  play(up, 76, 0.8, 0.4);
  const a = render(up, 40).L;

  const down = makeProcessor('piano-kw', 'piano');
  sendBank(down, loaded['piano-kw']);
  play(down, 48, 0.8, 0.4);
  const b = render(down, 40).L;

  check('音高越高，过零率越高（变调方向正确）', zcr(a, 512) > zcr(b, 512), `${zcr(a, 512).toFixed(4)} vs ${zcr(b, 512).toFixed(4)}`);
}

// ---------------------------------------------------------------- 循环延音
{
  const sp = makeProcessor('piano-kw', 'piano');
  sendBank(sp, loaded['piano-kw']);
  play(sp, 60, 0.8, 6.0);
  const { L } = render(sp, 1200); // 1200×128 ≈ 3.2 s
  const tail = peak(L, L.length - 4800);
  check('钢琴循环让长音 3 秒后仍有声', tail > 0.01, `tailPeak=${tail.toFixed(3)}`);
}

// ---------------------------------------------------------------- 非循环乐器自然收尾
{
  const sp = makeProcessor('bass-yr', 'bass');
  sendBank(sp, loaded['bass-yr']);
  play(sp, 40, 0.8, 6.0);
  const { L } = render(sp, 1900); // 1900×128 ≈ 5.07 s，超过 4.2 s 的采样上限
  const early = peak(L, 0, 4800);
  const late = peak(L, L.length - 4800);
  check('贝斯采样前段发声', early > 0.05, early.toFixed(3));
  check('贝斯采样无循环时会自然衰减', late < early * 0.5, `${late.toFixed(3)} vs ${early.toFixed(3)}`);
}

// ---------------------------------------------------------------- 鼓组与回退
{
  const sp = makeProcessor('drums-muldjord', 'drum');
  sendBank(sp, loaded['drums-muldjord']);
  play(sp, 36, 0.9, 0.3);
  const { L } = render(sp, 12);
  check('底鼓用采样发声', peak(L) > 0.05, `peak=${peak(L).toFixed(3)}`);
  const v = sp.tracks[3].voices[0];
  check('底鼓被标记为 kick 以保留踩镲互斥逻辑', v && v.piece === 'kick', v && v.piece);

  const clap = makeProcessor('drums-muldjord', 'drum');
  sendBank(clap, loaded['drums-muldjord']);
  play(clap, 49, 0.9, 0.3);
  const r = render(clap, 12);
  const v2 = clap.tracks[3].voices[0];
  check('鼓组无采样的键位回退合成鼓', peak(r.L) > 0.02 && v2 && v2.constructor.name === 'DrumVoice', v2 && v2.constructor.name);
}

{
  const sp = makeProcessor('no-such-bank', 'piano');
  play(sp, 60, 0.8, 0.5);
  const { L } = render(sp, 12);
  check('采样库缺失时回退合成音源而非静音', peak(L) > 0.05, `peak=${peak(L).toFixed(3)}`);
}

{
  const sp = makeProcessor('piano-kw', 'piano');
  sendBank(sp, loaded['piano-kw']);
  play(sp, 2, 0.8, 0.5); // 远超钢琴最低音，采样覆盖不到
  const { L } = render(sp, 12);
  check('音高超出采样覆盖范围时回退合成音源', peak(L) > 0.02, `peak=${peak(L).toFixed(3)}`);
}

// ---------------------------------------------------------------- 弯音与时长
{
  const sp = makeProcessor('piano-kw', 'piano');
  sendBank(sp, loaded['piano-kw']);
  play(sp, 60, 0.8, 0.35);
  sp.receive({ type: 'bend', track: 3, value: 1.5 });
  const { L } = render(sp, 16);
  check('采样声部支持弯音且不产生 NaN', L.every((v) => Number.isFinite(v)) && peak(L) > 0.02);
}

// ---------------------------------------------------------------- 与原始采样一致 + 与合成音源不同
{
  const sp = makeProcessor('piano-kw', 'piano');
  sendBank(sp, loaded['piano-kw']);
  play(sp, 60, 0.85, 0.4);
  render(sp, 8);
  const voice = sp.tracks[3].voices[0];
  // 直接取声部输出，避开轨道低通/合唱对波形的相位改变；
  // 前 1024 帧已经渲染过，按播放头对齐原始采样做相关
  const start = Math.floor(voice.pos);
  const rate = voice.rate;
  const buf = new Float32Array(1024);
  voice.renderTo(buf, 1024);
  const data = voice.data;
  const n = Math.min(buf.length, Math.floor((data.length - start) / Math.max(0.5, rate)));
  const at = (i) => {
    const p = start + i * rate;
    const i0 = Math.floor(p);
    const f = p - i0;
    return (data[i0] + (data[i0 + 1] - data[i0]) * f) / 32768;
  };
  let ml = 0;
  let md = 0;
  for (let i = 0; i < n; i++) {
    ml += buf[i];
    md += at(i);
  }
  ml /= n;
  md /= n;
  let num = 0;
  let dl = 0;
  let dd = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[i] - ml;
    const b = at(i) - md;
    num += a * b;
    dl += a * a;
    dd += b * b;
  }
  const corr = num / Math.sqrt(dl * dd || 1);
  check('根音演奏的波形与原始采样高度一致', corr > 0.9, `corr=${corr.toFixed(3)} rate=${rate.toFixed(3)}`);

  const synth = makeProcessor(null, 'piano');
  play(synth, 60, 0.85, 0.4);
  const s = render(synth, 40).L;
  const sampled = (() => {
    const t = makeProcessor('piano-kw', 'piano');
    sendBank(t, loaded['piano-kw']);
    play(t, 60, 0.85, 0.4);
    return render(t, 40).L;
  })();
  check('采样钢琴与合成钢琴的波形特性不同（不再是同一种声音）',
    Math.abs(zcr(sampled, 512) - zcr(s, 512)) > 0.0005,
    `采样 ${zcr(sampled, 512).toFixed(4)} vs 合成 ${zcr(s, 512).toFixed(4)}`);
}

// ---------------------------------------------------------------- 交付体积
{
  const sizes = banks.map((b) => ({
    id: b.id,
    mb: Math.round(b.samples.reduce((n, s) => n + fs.statSync(path.join('public', s.file)).size, 0) / 1e6),
  }));
  check('采样库总体积在可交付范围（< 80 MB）', sizes.reduce((n, b) => n + b.mb, 0) < 80, sizes.map((b) => `${b.id} ${b.mb}MB`).join(' · '));
}

// ---------------------------------------------------------------- 离线导出流程（与 renderOffline 相同的消息序列）
{
  const project = sb.createEmptyProject();
  const track = project.tracks[0];
  track.instrument = { presetId: 'piano-upright-kw', type: 'piano', params: {}, sampleBank: 'piano-kw' };
  const clip = sb.createClip(track.id, 0, 4, '采样钢琴');
  clip.notes = [
    { id: 'n1', pitch: 60, start: 0, length: 1.5, velocity: 0.8, articulation: 'normal' },
    { id: 'n2', pitch: 64, start: 1.5, length: 1.5, velocity: 0.7, articulation: 'normal' },
  ];
  project.clips = [clip];

  const plan = sb.buildSessionPlan(project);
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.postMessage = () => {};
  sendBank(sp, loaded['piano-kw']);
  for (const { message } of plan.trackMessages) sp.receive(message);
  sp.receive({ type: 'master', volume: project.master.volume });
  const spb = 60 / project.tempo;
  for (const n of plan.notes) {
    sp.receive({
      type: 'note',
      track: n.trackIndex,
      pitch: n.pitch,
      velocity: n.velocity,
      when: n.startBeat * spb,
      dur: (n.endBeat - n.startBeat) * spb,
      id: `${n.clipId}:${n.noteId}`,
      art: n.articulation,
      src: 'transport',
      gen: 0,
    });
  }
  const totalBlocks = Math.ceil((plan.endBeat * spb + 1.6) * SR / 128);
  const early = render(sp, 20);
  const voices = sp.tracks[0].voices;
  check('离线计划把 sampleBank 下发到轨道', voices.length > 0 && voices[0].constructor.name === 'SampleVoice', `${voices.length} voices`);
  const rest = render(sp, Math.max(0, totalBlocks - 20));
  const peakAll = Math.max(peak(early.L), peak(rest.L));
  check('离线导出路径使用采样并出声', peakAll > 0.05, `peak=${peakAll.toFixed(3)}`);
  check('离线导出路径无 NaN', early.L.every((v) => Number.isFinite(v)) && rest.L.every((v) => Number.isFinite(v)));
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
