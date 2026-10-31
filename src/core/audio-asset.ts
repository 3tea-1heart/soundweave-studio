import type { AudioAsset } from './types';

/** 单个 WAV 素材的时长上限（秒）；超过会拒绝导入，避免工程文件失控 */
export const MAX_ASSET_SECONDS = 300;
/** 时间轴峰值分箱：每 10 ms 一个峰值 */
export const PEAK_BINS_PER_SEC = 100;
const MAX_PEAK_BINS = MAX_ASSET_SECONDS * PEAK_BINS_PER_SEC;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

function base64ToBytes(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

/** 内容指纹：按步长采样量化后的 PCM（正/反两个方向），同内容同 id，同名同长度不同内容可区分 */
function hashPcm(pcm: Int16Array): string {
  const total = pcm.length;
  const stride = Math.max(1, Math.floor(total / 4096));
  let a = 2166136261;
  let b = 2166136261;
  for (let i = 0; i < total; i += stride) {
    a ^= pcm[i] & 0xffff;
    a = Math.imul(a, 16777619) >>> 0;
    const r = total - 1 - i;
    b ^= pcm[r] & 0xffff;
    b = Math.imul(b, 16777619) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}${total.toString(36)}`;
}

/** Float32 声道 → 交错 Int16 PCM（与 WAV 导出的量化规则一致） */
function quantizePcm16(channels: Float32Array[]): { pcm: Int16Array; ch: number; frames: number } {
  const ch = Math.max(1, Math.min(2, channels.length));
  let frames = channels[0]?.length ?? 0;
  for (let c = 1; c < channels.length; c++) frames = Math.min(frames, channels[c].length);
  const pcm = new Int16Array(frames * ch);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let s = channels[c][i];
      if (!Number.isFinite(s)) s = 0;
      s = Math.max(-1, Math.min(1, s));
      pcm[o++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
  }
  return { pcm, ch, frames };
}

export function assetFrames(asset: AudioAsset): number {
  return Math.max(0, Math.round(asset.duration * asset.sampleRate));
}

/** Float32 → Int16 交错 PCM → base64（与 WAV 导出的量化规则一致） */
export function encodePcm16(channels: Float32Array[]): string {
  const { pcm } = quantizePcm16(channels);
  return bytesToBase64(new Uint8Array(pcm.buffer));
}

/** base64 PCM → Float32 声道；data 缺失或损坏时返回 null */
export function decodeAssetPcm(asset: AudioAsset): Float32Array[] | null {
  if (!asset.data) return null;
  const bytes = base64ToBytes(asset.data);
  if (!bytes) return null;
  const ch = asset.channels === 2 ? 2 : 1;
  const frames = Math.min(assetFrames(asset), Math.floor(bytes.length / (ch * 2)));
  if (frames <= 0) return null;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, frames * ch);
  const out: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    const arr = new Float32Array(frames);
    for (let i = 0; i < frames; i++) arr[i] = pcm[i * ch + c] / 32768;
    out.push(arr);
  }
  return out;
}

/** 逐 bin 取各声道最大绝对值，供时间轴绘制 */
export function peaksFromChannels(channels: Float32Array[], sampleRate: number): number[] {
  const frames = channels[0]?.length ?? 0;
  const bins = Math.min(MAX_PEAK_BINS, Math.max(1, Math.round((frames / sampleRate) * PEAK_BINS_PER_SEC)));
  const out = new Array<number>(bins).fill(0);
  if (!frames) return out;
  const per = frames / bins;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(frames, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      for (const ch of channels) {
        const a = Math.abs(ch[i] ?? 0);
        if (a > peak) peak = a;
      }
    }
    out[b] = Math.min(1, Math.round(peak * 1000) / 1000);
  }
  return out;
}

export function createAudioAsset(name: string, sampleRate: number, channels: Float32Array[]): AudioAsset {
  const { pcm, ch, frames } = quantizePcm16(channels);
  const cleanName = String(name || '音频素材').slice(0, 100);
  // id 由文件名、采样率与 PCM 内容共同决定：同名同长度不同内容不会撞 id，同内容重导入可自动重连
  const id = `a_${hashText(`${cleanName}|${sampleRate}|${ch}`)}_${hashPcm(pcm)}`;
  return {
    id,
    name: cleanName,
    sampleRate,
    channels: ch,
    duration: frames / sampleRate,
    data: bytesToBase64(new Uint8Array(pcm.buffer)),
    peaks: peaksFromChannels(channels, sampleRate),
  };
}

/** 校验外部/保存的素材元数据；data 可缺失（自动保存剥离或素材未收集） */
export function sanitizeAudioAsset(raw: unknown): AudioAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AudioAsset>;
  const id = typeof r.id === 'string' ? r.id.trim().slice(0, 80) : '';
  if (!id) return null;
  const sampleRate = Number(r.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null;
  const channels = r.channels === 2 ? 2 : 1;
  const duration = Number(r.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_ASSET_SECONDS) return null;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : '音频素材';
  const data = typeof r.data === 'string' && r.data.length >= 4 ? r.data : undefined;
  let peaks: number[] | undefined;
  if (Array.isArray(r.peaks)) {
    peaks = r.peaks
      .slice(0, MAX_PEAK_BINS)
      .map((v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, Number(v))) : 0));
  }
  return { id, name, sampleRate, channels, duration, data, peaks };
}

/** 自动保存用：去掉 PCM，只留元数据与波形峰值 */
export function stripAssetData(assets: AudioAsset[]): AudioAsset[] {
  return assets.map((a) => ({ id: a.id, name: a.name, sampleRate: a.sampleRate, channels: a.channels, duration: a.duration, peaks: a.peaks }));
}

export function assetById(assets: AudioAsset[] | undefined, id: string): AudioAsset | undefined {
  return assets?.find((a) => a.id === id);
}

export type AssetImportMode = 'new' | 'existing' | 'restore' | 'rebind';

export interface AudioAssetImport {
  asset: AudioAsset;
  mode: AssetImportMode;
}

/**
 * 把导入的素材并入工程素材表，并区分“放置新片段”与“补回被剥离的 PCM”：
 * - `existing`：同 id 且已有 PCM，素材保持原样，调用方可再摆一个片段；
 * - `restore`：同 id 但缺 PCM（自动保存剥离过），补回 PCM，不应新增片段；
 * - `rebind`：id 不同但文件名/采样率/声道/时长一致且缺 PCM（旧版本或旧 id 规则留下的引用），
 *   沿用旧 id 补回 PCM，让已有片段自动重连；
 * - `new`：全新素材，已追加到表中。
 */
export function adoptAudioAsset(assets: AudioAsset[], incoming: AudioAsset): AudioAssetImport {
  const same = assets.find((a) => a.id === incoming.id);
  if (same) {
    if (!same.data) {
      same.data = incoming.data;
      same.peaks = incoming.peaks;
      return { asset: same, mode: 'restore' };
    }
    return { asset: same, mode: 'existing' };
  }
  const orphan = assets.find(
    (a) => !a.data
      && a.name === incoming.name
      && a.sampleRate === incoming.sampleRate
      && a.channels === incoming.channels
      && Math.abs(a.duration - incoming.duration) < 0.05,
  );
  if (orphan) {
    orphan.data = incoming.data;
    orphan.peaks = incoming.peaks;
    orphan.sampleRate = incoming.sampleRate;
    orphan.channels = incoming.channels;
    orphan.duration = incoming.duration;
    return { asset: orphan, mode: 'rebind' };
  }
  assets.push(incoming);
  return { asset: incoming, mode: 'new' };
}
