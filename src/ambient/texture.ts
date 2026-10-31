/**
 * 纹理 / 持续声音层合成（M2 Sound/Texture 层）。
 * 与 MIDI 音符不同，这里直接合成一段「可无缝循环」的立体声素材：
 * 所有分音均按循环周期做频率对齐，幅度调制也周期对齐，因此首尾相接无咔哒声。
 * 生成器把这段短循环切成背靠背的音频片段铺满整个时长，得到一条真实的非 MIDI 纹理轨。
 * 全程使用确定性 Rng：固定 seed 得到逐样本一致的素材，满足可复现要求。
 */
import type { AudioAsset } from '../core/types';
import type { TextureSpec, TextureKind } from './types';
import { createAudioAsset } from '../core/audio-asset';
import { Rng, seedString } from './rng';
import { midiToHz } from './music';

const TWO_PI = Math.PI * 2;

interface KindProfile {
  /** 循环长度（秒） */
  loopSec: number;
  /** 加法正弦分音数 */
  partials: number;
  /** 分音覆盖的半音跨度（自基频向上） */
  spread: number;
  /** 亮度 0–1：越高，高次分音权重越大 */
  brightness: number;
  /** 慢幅度调制速率（Hz，写作 loopSec 的整数倍以保持无缝） */
  lfoRate: number;
  /** 幅度调制深度 0–1 */
  lfoDepth: number;
}

const PROFILES: Record<TextureKind, KindProfile> = {
  drone: { loopSec: 16, partials: 5, spread: 12, brightness: 0.12, lfoRate: 0.0625, lfoDepth: 0.35 },
  shimmer: { loopSec: 12, partials: 10, spread: 24, brightness: 0.72, lfoRate: 0.125, lfoDepth: 0.3 },
  noise: { loopSec: 12, partials: 34, spread: 30, brightness: 0.5, lfoRate: 0.0417, lfoDepth: 0.22 },
  grain: { loopSec: 8, partials: 6, spread: 14, brightness: 0.28, lfoRate: 0.875, lfoDepth: 0.55 },
};

export interface TextureSynthOptions {
  spec: TextureSpec;
  seed: string;
  /** 调性中心（MIDI） */
  tonic: number;
  sampleRate?: number;
}

/** 纹理默认采样率：足够覆盖 texture 频段，Iconic 逐分音合成的成本也较低（宿主会按需重采样） */
export const TEXTURE_SAMPLE_RATE = 32000;

export function textureLoopSec(spec: TextureSpec): number {
  return (PROFILES[spec.kind] ?? PROFILES.drone).loopSec;
}

export function synthesizeTextureAsset(opts: TextureSynthOptions): AudioAsset {
  const profile = PROFILES[opts.spec.kind] ?? PROFILES.drone;
  const sr = opts.sampleRate ?? TEXTURE_SAMPLE_RATE;
  const loopSec = profile.loopSec;
  const frames = Math.max(1, Math.round(loopSec * sr));
  const loopFreq = 1 / loopSec;

  const baseHz = midiToHz(opts.tonic + opts.spec.baseOffset);

  // 分音频率按循环周期 bin 对齐（确定性，不依赖 Rng），保证首尾无缝
  const last = Math.max(1, profile.partials - 1);
  const partials: Array<{ freq: number; amp: number }> = [];
  for (let i = 0; i < profile.partials; i++) {
    const t = i / last;
    // 顶部略偏置：让高频分音更分散；亮度作为幅度权重而非常度分布
    const semis = profile.spread * Math.pow(t, 1.5);
    const f = baseHz * Math.pow(2, semis / 12);
    const bin = Math.max(1, Math.round(f / loopFreq));
    const freq = bin * loopFreq;
    const amp = (1 - profile.brightness) + profile.brightness * t;
    partials.push({ freq, amp });
  }

  // 幅度调制速率也对齐到 loop 格，保证包络循环闭合
  const lfoCycles = Math.max(1, Math.round(profile.lfoRate * loopSec));
  const lfoFreq = lfoCycles / loopSec;

  const seed = seedString(`${opts.seed}:texture:${opts.spec.id}:${opts.spec.kind}`);
  const L = renderChannel(seedString(seed + ':L'), partials, sr, frames, lfoFreq, profile.lfoDepth);
  const R = renderChannel(seedString(seed + ':R'), partials, sr, frames, lfoFreq, profile.lfoDepth);

  // 归一化到目标音量（留出余量，避免量化削顶）
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
  }
  const targetPeak = Math.max(0.001, Math.min(1, opts.spec.volume)) * 0.85;
  if (peak > 0) {
    const g = targetPeak / peak;
    for (let i = 0; i < frames; i++) {
      L[i] *= g;
      R[i] *= g;
    }
  }

  return createAudioAsset(`${opts.spec.id} 纹理`, sr, [L, R]);
}

function renderChannel(
  seed: string,
  partials: Array<{ freq: number; amp: number }>,
  sr: number,
  frames: number,
  lfoFreq: number,
  depth: number,
): Float32Array {
  const rng = new Rng(seedString(seed));
  const out = new Float32Array(frames);
  const n = partials.length;
  const phases = new Float64Array(n);
  const lfoPhase1 = new Float64Array(n);
  const lfoPhase2 = new Float64Array(n);
  const lfoRate2 = lfoFreq * 1.5;
  for (let i = 0; i < n; i++) {
    phases[i] = rng.next() * TWO_PI;
    lfoPhase1[i] = rng.next() * TWO_PI;
    lfoPhase2[i] = rng.next() * TWO_PI;
  }
  const invN = 1 / Math.max(1, n);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    let acc = 0;
    for (let p = 0; p < n; p++) {
      const lfo1 = 0.5 + 0.5 * Math.sin(TWO_PI * lfoFreq * t + lfoPhase1[p]);
      const lfo2 = 0.5 + 0.5 * Math.sin(TWO_PI * lfoRate2 * t + lfoPhase2[p]);
      const env = ((1 - depth) + depth * lfo1) * ((1 - depth) + depth * lfo2);
      acc += partials[p].amp * env * Math.sin(TWO_PI * partials[p].freq * t + phases[p]);
    }
    out[i] = acc * invN;
  }
  return out;
}