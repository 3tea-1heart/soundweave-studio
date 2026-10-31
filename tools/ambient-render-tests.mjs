/**
 * Generative Ambient M2 离线渲染 + 纹理音轨回归测试。
 * 用法：node tools/ambient-render-tests.mjs
 * 覆盖：真实纹理音轨（带 PCM 的 audio clip）、非 NaN/可闻渲染、WAV 可解码、渲染确定性。
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
const { decodeWav } = await loadTs(join(ROOT, 'src/core/wav.ts'));
const { decodeAssetPcm } = await loadTs(join(ROOT, 'src/core/audio-asset.ts'));

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

function rms(L, R) {
  let sum = 0;
  const n = L.length;
  for (let i = 0; i < n; i++) sum += L[i] * L[i] + R[i] * R[i];
  return Math.sqrt(sum / (n * 2));
}

function countNonFinite(channels) {
  let n = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) n++;
  return n;
}

// ----------------------------------------------------------------- 纹理音轨：带 PCM 的 audio clip
{
  let textureOk = true;
  let detail = '';
  for (const id of amb.presetIds()) {
    const preset = amb.getPreset(id);
    const g = amb.generateAmbientPiece({ presetId: id, seed: 'tex', durationSec: 20 });
    const p = g.project;
    const audioTracks = p.tracks.filter((t) => t.kind === 'audio');
    if (preset.texture?.length) {
      if (audioTracks.length !== preset.texture.length) { textureOk = false; detail = `${id}:纹理轨数`; }
    }
    for (const t of audioTracks) {
      const clip = p.clips.find((c) => c.trackId === t.id);
      if (!clip || !clip.audio?.assetId || clip.notes.length !== 0) { textureOk = false; detail = `${id}:缺音频 clip`; continue; }
      const asset = (p.audioAssets || []).find((a) => a.id === clip.audio.assetId);
      const channels = asset ? decodeAssetPcm(asset) : null;
      if (!channels || channels.length < 1) { textureOk = false; detail = `${id}:纹理素料无 PCM`; continue; }
      if (rms(channels, channels.length > 1 ? channels[1] : channels[0]) < 0.005) { textureOk = false; detail = `${id}:纹理静音`; }
    }
  }
  check('纹理：4 预设各含真实非 MIDI 纹理轨（audio clip + 可闻 PCM）', textureOk, detail);
}

// ----------------------------------------------------------------- 离线渲染：非 NaN / 可闻 / 时长
{
  const g = amb.generateAmbient({ presetId: 'phase-garden', seed: 'render', durationSec: 20, tempo: 90 });
  const SR = 48000;
  const r = amb.renderAmbient(g, { sampleRate: SR });
  const expectedSec = 20 + 1.6;
  check('渲染：返回立体声 [L,R]', r.channels.length === 2 && r.channels[0].length === r.channels[1].length);
  check('渲染：时长正确（含尾音）', Math.abs(r.seconds - expectedSec) < 1e-6, `=${r.seconds.toFixed(3)}`);
  check('渲染：无非法数值', countNonFinite(r.channels) === 0);
  check('渲染：可闻（非静音）', rms(r.channels[0], r.channels[1]) > 0.005);
  check('渲染：帧数匹配采样率', r.frames === Math.ceil(expectedSec * SR), `=${r.frames}`);
}

// ----------------------------------------------------------------- WAV 编码可被宿主 decodeWav 解析
{
  const g = amb.generateAmbient({ presetId: 'still-room', seed: 'wav', durationSec: 15, tempo: 60 });
  const SR = 48000;
  const wav = amb.renderAmbientWav(g, { sampleRate: SR });
  check('WAV：非空字节', wav instanceof Uint8Array && wav.byteLength > 44, `len=${wav.byteLength}`);
  const dec = decodeWav(wav.buffer);
  check('WAV：采样率一致', dec.sampleRate === SR, `=${dec.sampleRate}`);
  check('WAV：双声道', dec.channels.length === 2);
  check('WAV：时长接近', Math.abs(dec.duration - (15 + 1.6)) < 0.02, `=${dec.duration.toFixed(3)}`);
  check('WAV：解码后可闻', rms(dec.channels[0], dec.channels[1]) > 0.005);
}

// ----------------------------------------------------------------- 渲染确定性（同工程两次渲染逐样本一致）
{
  const g = amb.generateAmbient({ presetId: 'pentatonic-weather', seed: 'det', durationSec: 10, tempo: 78 });
  const a = amb.renderAmbient(g, { sampleRate: 32000 });
  const b = amb.renderAmbient(g, { sampleRate: 32000 });
  let same = true;
  for (let i = 0; i < a.channels[0].length; i++) {
    if (a.channels[0][i] !== b.channels[0][i] || a.channels[1][i] !== b.channels[1][i]) { same = false; break; }
  }
  check('确定：同工程二次渲染逐样本一致', same);
}

// ----------------------------------------------------------------- 纹理轨确实进入混音（带 PCM 素材的管线）
{
  const g = amb.generateAmbient({ presetId: 'sparse-fog', seed: 'mix', durationSec: 12, tempo: 60 });
  const audioTrack = g.tracks.find((t) => t.kind === 'audio');
  const clip = g.clips.find((c) => c.trackId === audioTrack.id);
  const asset = g.audioAssets.find((a) => a.id === clip.audio.assetId);
  check('混音：纹理片段引用素材且素材在表中', !!asset && asset.sampleRate > 0 && asset.channels === 2);
}

console.log('---------------------------------------------');
console.log(`总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;