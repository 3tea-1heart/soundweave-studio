/**
 * WAV 解码与音频素材编解码测试。
 * 用法：node tools/audio-asset-tests.mjs
 *
 * 覆盖：WAV PCM 8/16/24/32 位、float32/float64、WAVE_FORMAT_EXTENSIBLE、
 * 常见错误输入，以及 AudioAsset 的 PCM base64 往返、峰值、校验与剥离。
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

const { decodeWav, encodeWav } = await loadTs(join(ROOT, 'src/core/wav.ts'));
const {
  MAX_ASSET_SECONDS,
  PEAK_BINS_PER_SEC,
  assetFrames,
  encodePcm16,
  decodeAssetPcm,
  peaksFromChannels,
  createAudioAsset,
  sanitizeAudioAsset,
  stripAssetData,
  assetById,
  adoptAudioAsset,
} = await loadTs(join(ROOT, 'src/core/audio-asset.ts'));

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
function near(a, b, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------- WAV 构造
function buildWav({ fmt = 1, channels, sampleRate, bits, data, extensible = false }) {
  const fmtBody = extensible ? 40 : 16;
  const pad = data.length & 1;
  const total = 12 + 8 + fmtBody + 8 + data.length + pad;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const wstr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, fmtBody, true);
  view.setUint16(20, extensible ? 0xfffe : fmt, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bits, true); // valid bits
    view.setUint32(40, 0, true); // channel mask
    view.setUint16(44, fmt, true); // SubFormat GUID 前两字节
  }
  const dataHeader = 12 + 8 + fmtBody;
  wstr(dataHeader, 'data');
  view.setUint32(dataHeader + 4, data.length, true);
  new Uint8Array(buffer, dataHeader + 8, data.length).set(data);
  return buffer;
}

function bytesFor(samples, bits, fmt = 1) {
  const n = samples.length;
  let out;
  if (bits === 8) {
    out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round(samples[i] * 127 + 128)));
  } else if (bits === 16) {
    out = new Uint8Array(n * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(samples[i] * 32767), true);
  } else if (bits === 24) {
    out = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const raw = Math.max(-8388608, Math.min(8388607, Math.round(samples[i] * 8388607)));
      out[i * 3] = raw & 0xff;
      out[i * 3 + 1] = (raw >> 8) & 0xff;
      out[i * 3 + 2] = (raw >> 16) & 0xff;
    }
  } else if (bits === 32 && fmt === 3) {
    out = new Uint8Array(n * 4);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setFloat32(i * 4, samples[i], true);
  } else if (bits === 64 && fmt === 3) {
    out = new Uint8Array(n * 8);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setFloat64(i * 8, samples[i], true);
  } else {
    out = new Uint8Array(n * 4);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setInt32(i * 4, Math.max(-2147483648, Math.min(2147483647, Math.round(samples[i] * 2147483647))), true);
  }
  return out;
}

const SR = 44100;
const ramp = [0, 0.25, -0.25, 0.5, -0.5, 1, -1];

// ---------------------------------------------------------------- 解码
{
  const data = bytesFor(ramp, 16);
  const wav = buildWav({ channels: 1, sampleRate: SR, bits: 16, data });
  const d = decodeWav(wav);
  check('decodeWav 16-bit 采样率', d.sampleRate === SR, `${d.sampleRate}`);
  check('decodeWav 16-bit 单声道', d.channels.length === 1);
  check('decodeWav 16-bit 帧数', d.channels[0].length === ramp.length, `${d.channels[0].length}`);
  check('decodeWav 16-bit 时长', near(d.duration, ramp.length / SR, 1e-9), `${d.duration}`);
  check('decodeWav 16-bit 数值', near(d.channels[0][3], 0.5) && near(d.channels[0][4], -0.5));
  check('decodeWav 16-bit 峰值', near(d.channels[0][5], 1, 1e-3) && near(d.channels[0][6], -1, 1e-3));
}
{
  const data = bytesFor(ramp, 24);
  const d = decodeWav(buildWav({ channels: 1, sampleRate: SR, bits: 24, data }));
  check('decodeWav 24-bit 正负值', near(d.channels[0][3], 0.5) && near(d.channels[0][4], -0.5));
  check('decodeWav 24-bit 满幅', near(d.channels[0][5], 1, 1e-3) && near(d.channels[0][6], -1, 1e-3));
}
{
  const data = bytesFor(ramp, 32);
  const d = decodeWav(buildWav({ channels: 1, sampleRate: SR, bits: 32, data }));
  check('decodeWav 32-bit PCM', near(d.channels[0][3], 0.5) && near(d.channels[0][4], -0.5));
}
{
  const data = bytesFor(ramp, 8);
  const d = decodeWav(buildWav({ channels: 1, sampleRate: SR, bits: 8, data }));
  check('decodeWav 8-bit PCM', near(d.channels[0][3], 0.5, 0.01) && near(d.channels[0][0], 0, 0.01));
}
{
  const data = bytesFor(ramp, 32, 3);
  const d = decodeWav(buildWav({ fmt: 3, channels: 1, sampleRate: SR, bits: 32, data }));
  check('decodeWav float32', near(d.channels[0][3], 0.5, 1e-6) && near(d.channels[0][4], -0.5, 1e-6));
}
{
  const data = bytesFor(ramp, 64, 3);
  const d = decodeWav(buildWav({ fmt: 3, channels: 1, sampleRate: SR, bits: 64, data }));
  check('decodeWav float64', near(d.channels[0][3], 0.5, 1e-9) && near(d.channels[0][4], -0.5, 1e-9));
}
{
  const inter = [0, 0, 0.5, -0.5, -0.5, 0.5];
  const data = bytesFor(inter, 16);
  const d = decodeWav(buildWav({ channels: 2, sampleRate: SR, bits: 16, data }));
  check('decodeWav 立体声分声道', d.channels.length === 2 && near(d.channels[1][1], -0.5) && near(d.channels[0][2], -0.5));
}
{
  const inter = [0.5, -0.5, 0.25, 0.75];
  const data = bytesFor(inter, 16);
  const d = decodeWav(buildWav({ channels: 2, sampleRate: SR, bits: 16, data, extensible: true }));
  check('decodeWav WAVE_FORMAT_EXTENSIBLE', d.channels.length === 2 && d.sampleRate === SR && near(d.channels[0][0], 0.5) && near(d.channels[1][1], 0.75));
}
{
  let threw = false;
  try {
    decodeWav(new ArrayBuffer(16));
  } catch {
    threw = true;
  }
  check('decodeWav 拒绝非 WAV', threw);
}
{
  let threw = '';
  try {
    const data = new Uint8Array(16);
    const body = new Uint8Array(20);
    const v = new DataView(body.buffer);
    v.setUint16(0, 1, true);
    v.setUint16(2, 1, true);
    v.setUint32(4, SR, true);
    v.setUint16(14, 20, true);
    decodeWav(buildWav({ channels: 1, sampleRate: SR, bits: 20, data }));
    void data;
    void body;
  } catch (e) {
    threw = String(e.message || e);
  }
  check('decodeWav 拒绝 20 位', threw.includes('20'), threw);
}
{
  // 64 位整数 PCM（fmt=1）应明确拒绝，而不是落入 32 位分支
  const data = new Uint8Array(8);
  let threw = '';
  try {
    decodeWav(buildWav({ channels: 1, sampleRate: SR, bits: 64, data }));
  } catch (e) {
    threw = String(e.message || e);
  }
  check('decodeWav 拒绝 64 位整数', threw.includes('64'), threw);
}
{
  const frames = 200;
  const sine = new Float32Array(frames);
  for (let i = 0; i < frames; i++) sine[i] = Math.sin((i / frames) * Math.PI * 2) * 0.8;
  const wav = encodeWav([sine], SR);
  const d = decodeWav(wav);
  let maxErr = 0;
  for (let i = 0; i < frames; i++) maxErr = Math.max(maxErr, Math.abs(d.channels[0][i] - sine[i]));
  check('encodeWav → decodeWav 往返', maxErr < 1e-4, `maxErr=${maxErr.toExponential(2)}`);
}

// ---------------------------------------------------------------- 素材编解码
{
  const mono = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const asset = {
    id: 'a_test',
    name: 'test',
    sampleRate: SR,
    channels: 1,
    duration: mono.length / SR,
    data: encodePcm16([mono]),
  };
  const back = decodeAssetPcm(asset);
  check('PCM16 往返单声道', !!back && back.length === 1 && near(back[0][1], 0.5, 1e-4) && near(back[0][2], -0.5, 1e-4));
  check('PCM16 满幅往返', !!back && near(back[0][3], 1, 1e-4) && near(back[0][4], -1, 1e-4));

  const missing = { ...asset, data: undefined };
  check('decodeAssetPcm 无 data 返回 null', decodeAssetPcm(missing) === null);
  const broken = { ...asset, data: '@@@@' };
  const brokenOut = decodeAssetPcm(broken);
  check('decodeAssetPcm 损坏 base64 返回 null', brokenOut === null, brokenOut ? 'unexpected' : '');
}
{
  // 超过 8192 字节分块边界
  const frames = 7000;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = Math.sin(i / 17) * 0.6;
    right[i] = Math.cos(i / 23) * 0.4;
  }
  const b64 = encodePcm16([left, right]);
  check('PCM16 长数据分块 base64', b64.length > 8192 && /^[A-Za-z0-9+/]+=*$/.test(b64), `len=${b64.length}`);
  const asset = {
    id: 'a_long',
    name: 'long',
    sampleRate: SR,
    channels: 2,
    duration: frames / SR,
    data: b64,
  };
  const back = decodeAssetPcm(asset);
  let maxErr = 0;
  for (let i = 0; i < frames; i++) {
    maxErr = Math.max(maxErr, Math.abs(back[0][i] - left[i]), Math.abs(back[1][i] - right[i]));
  }
  check('PCM16 长数据往返', !!back && back.length === 2 && maxErr < 1e-3, `maxErr=${maxErr.toExponential(2)}`);
}
{
  const frames = SR;
  const sine = new Float32Array(frames);
  for (let i = 0; i < frames; i++) sine[i] = Math.sin((i / SR) * 2 * Math.PI * 440) * 0.9;
  const asset = createAudioAsset('正弦 1 秒.wav', SR, [sine]);
  check('createAudioAsset 声道与时长', asset.channels === 1 && near(asset.duration, 1, 1e-6));
  check('createAudioAsset 含 PCM 与峰值', typeof asset.data === 'string' && Array.isArray(asset.peaks));
  check('createAudioAsset 峰值 bin 数', asset.peaks.length === Math.round(asset.duration * PEAK_BINS_PER_SEC), `${asset.peaks.length}`);
  check('createAudioAsset 峰值范围', Math.max(...asset.peaks) <= 1 && Math.min(...asset.peaks) >= 0 && Math.max(...asset.peaks) > 0.85);
  const again = createAudioAsset('正弦 1 秒.wav', SR, [sine]);
  check('createAudioAsset id 确定性', again.id === asset.id, asset.id);
  const other = createAudioAsset('别的.wav', SR, [sine]);
  check('createAudioAsset 名称改变 id', other.id !== asset.id, other.id);
  const flipped = sine.slice();
  for (let i = 0; i < flipped.length; i++) flipped[i] = -flipped[i];
  const diff = createAudioAsset('正弦 1 秒.wav', SR, [flipped]);
  check('createAudioAsset 同名同长不同内容改变 id', diff.id !== asset.id, diff.id);
  check('createAudioAsset 重导入同内容可重连', createAudioAsset('正弦 1 秒.wav', SR, [sine.slice()]).id === asset.id);
  check('assetFrames', assetFrames(asset) === frames, `${assetFrames(asset)}`);
}
{
  const silent = [new Float32Array(400), new Float32Array(400)];
  const peaks = peaksFromChannels(silent, 44100);
  check('peaksFromChannels 静音为 0', peaks.length >= 1 && peaks.every((v) => v === 0));
  const loud = [new Float32Array([0, 1, -1, 0.5])];
  check('peaksFromChannels 取绝对值', Math.max(...peaksFromChannels(loud, 44100)) === 1);
}

// ---------------------------------------------------------------- 校验与剥离
{
  const good = createAudioAsset('ok.wav', SR, [new Float32Array(100).fill(0.3)]);
  check('sanitize 保留合法素材', sanitizeAudioAsset(good)?.id === good.id);
  check('sanitize 拒绝缺 id', sanitizeAudioAsset({ ...good, id: '' }) === null);
  check('sanitize 拒绝低采样率', sanitizeAudioAsset({ ...good, sampleRate: 4000 }) === null);
  check('sanitize 拒绝超长', sanitizeAudioAsset({ ...good, duration: MAX_ASSET_SECONDS + 1 }) === null);
  check('sanitize 拒绝零时长', sanitizeAudioAsset({ ...good, duration: 0 }) === null);
  const coerced = sanitizeAudioAsset({ ...good, channels: 3 });
  check('sanitize 声道收敛为 1/2', coerced?.channels === 1, `${coerced?.channels}`);
  const clamped = sanitizeAudioAsset({ ...good, peaks: [1.5, -1, 0.2] });
  check('sanitize 峰值裁剪', !!clamped && clamped.peaks[0] === 1 && clamped.peaks[1] === 0);
  const meta = sanitizeAudioAsset({ ...good, data: undefined });
  check('sanitize 允许缺 data', !!meta && !meta.data);
  check('sanitize 拒绝非对象', sanitizeAudioAsset(null) === null && sanitizeAudioAsset('x') === null);
}
{
  const a = createAudioAsset('a.wav', SR, [new Float32Array(50)]);
  const b = createAudioAsset('b.wav', SR, [new Float32Array(50).fill(0.5)]);
  const stripped = stripAssetData([a, b]);
  check('stripAssetData 去掉 PCM', stripped.every((x) => !x.data));
  check('stripAssetData 保留峰值', stripped.every((x, i) => Array.isArray(x.peaks) && x.peaks.length === [a, b][i].peaks.length));
  check('stripAssetData 保留元数据', stripped[1].id === b.id && stripped[1].duration === b.duration);
  check('assetById 查找', assetById(stripped, b.id)?.name === 'b.wav' && assetById(stripped, 'nope') === undefined);
  check('assetById 空表', assetById(undefined, b.id) === undefined);
}

// adoptAudioAsset：新素材入表、补回被剥离的 PCM、旧 id 绑回
{
  const sine = new Float32Array(SR).map((_, i) => Math.sin((i / SR) * 2 * Math.PI * 220) * 0.5);
  const base = createAudioAsset('adopt.wav', SR, [sine]);
  const bare = (asset, id = asset.id) => ({ ...asset, id, data: undefined });

  const list = [];
  const first = adoptAudioAsset(list, base);
  check('adopt 新素材 mode=new 并入表', first.mode === 'new' && list.length === 1 && first.asset.id === base.id);

  const again = adoptAudioAsset(list, createAudioAsset('adopt.wav', SR, [sine.slice()]));
  check('adopt 同内容再导入 mode=existing 不重复', again.mode === 'existing' && list.length === 1 && !!again.asset.data);

  const list2 = [bare(base)];
  const restored = adoptAudioAsset(list2, createAudioAsset('adopt.wav', SR, [sine.slice()]));
  check('adopt 缺 PCM 同 id mode=restore 且补回数据', restored.mode === 'restore' && list2.length === 1 && !!list2[0].data);

  const list3 = [bare(base, 'a_legacy_123')];
  const rebound = adoptAudioAsset(list3, createAudioAsset('adopt.wav', SR, [sine.slice()]));
  check(
    'adopt 旧 id 缺 PCM mode=rebind 沿用旧 id',
    rebound.mode === 'rebind' && list3.length === 1 && rebound.asset.id === 'a_legacy_123' && !!list3[0].data,
    rebound.asset.id,
  );

  const list4 = [bare(base, 'a_legacy_456')];
  list4[0].name = 'another.wav';
  const miss = adoptAudioAsset(list4, createAudioAsset('adopt.wav', SR, [sine.slice()]));
  check('adopt 文件名不同不绑回', miss.mode === 'new' && list4.length === 2);
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
