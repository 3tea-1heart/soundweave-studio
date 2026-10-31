/**
 * 采样音源库（真实乐器录音）。
 *
 * 音频文件由 tools/sample-build.py 从 SFZ 采样包生成：
 *   48 kHz / 16-bit / 单声道 WAV，放在 public/samples/<bank>/ 下。
 * 清单 src/samples/manifest.json 记录每个采样的根音、力度层与循环点。
 * 素材来源与授权见 docs/samples.md。
 */
import manifest from '../samples/manifest.json';
import type { InstrumentType } from './types';

export interface SampleSpec {
  /** 相对站点根目录的 WAV 路径，例如 samples/piano-kw/A0vL.wav */
  file: string;
  /** 采样根音（MIDI 音高） */
  pitch: number;
  velMin: number;
  velMax: number;
  /** 循环起止（秒），无循环为 null */
  loopStart: number | null;
  loopEnd: number | null;
}

export interface BankDef {
  id: string;
  name: string;
  kind: 'pitched' | 'drums';
  type: InstrumentType;
  license: string;
  source: string;
  samples: SampleSpec[];
}

export interface LoadedSample extends SampleSpec {
  sampleRate: number;
  /** Int16 单声道 PCM，音频线程直接使用，避免整库 Float32 占内存 */
  data: Int16Array;
}

export interface LoadedBank {
  id: string;
  kind: 'pitched' | 'drums';
  sampleRate: number;
  samples: LoadedSample[];
}

export const SAMPLE_BANKS: BankDef[] = (manifest as { banks: BankDef[] }).banks;

export function bankById(id: string | null | undefined): BankDef | undefined {
  if (!id) return undefined;
  return SAMPLE_BANKS.find((b) => b.id === id);
}

/** 读取 16-bit PCM WAV（我们生成的采样固定为单声道 48 kHz） */
function readPcm16Mono(buffer: ArrayBuffer): { data: Int16Array; sampleRate: number } {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint32(0, false) !== 0x52494646) throw new Error('不是 RIFF/WAVE 文件');
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const tag = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (tag === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (tag === 'data') {
      if (bits !== 16 || channels < 1 || channels > 2) throw new Error('采样必须是 16-bit 单/双声道 WAV');
      const frames = Math.floor(size / (2 * channels));
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        if (channels === 1) {
          out[i] = view.getInt16(offset + 8 + i * 2, true);
        } else {
          const l = view.getInt16(offset + 8 + i * 4, true);
          const r = view.getInt16(offset + 8 + i * 4 + 2, true);
          out[i] = (l + r) / 2;
        }
      }
      return { data: out, sampleRate };
    }
    offset += 8 + size + (size % 2); // chunk 按偶数字节对齐
  }
  throw new Error('WAV 缺少 data 块');
}

/** 下载并解码一个采样库；网络/格式异常会抛错，由调用方回退到合成音源 */
export async function fetchBank(bank: BankDef): Promise<LoadedBank> {
  const requests = bank.samples.map(async (spec) => {
    const res = await fetch(spec.file);
    if (!res.ok) throw new Error(`采样 ${spec.file} 加载失败：HTTP ${res.status}`);
    const parsed = readPcm16Mono(await res.arrayBuffer());
    return { ...spec, sampleRate: parsed.sampleRate, data: parsed.data };
  });
  const samples = await Promise.all(requests);
  const sampleRate = samples[0]?.sampleRate || 48000;
  return { id: bank.id, kind: bank.kind, sampleRate, samples };
}
