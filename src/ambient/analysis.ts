/**
 * 参考音频分析（M3 AudioAnalyzer）。
 * 真实频谱/时域特征提取：先把 PCM 下混为单声道，再按微观窗做 FFT，
 * 计算频谱质心 / 滚降 / 亮度 / 平坦度 / 粗糙度（谱不规则度）/ 通量 / 峰值因子，
 * 并估计 onset 密度、chroma、调性中心、音高稳定性、立体声宽度、动态范围，
 * 以及宏观的密度/亮度/张力漂移与自相似 recurrence。
 * 符号估计（onset/tonic/chroma）失败不阻塞：强度会体现在 tonicStrength/pitchStability 中。
 */
import { magnitudeSpectrum, hannWindow } from './fft';

export interface MicroProfile {
  /** 频谱质心（Hz） */
  centroidHz: number;
  /** 85% 频谱滚降点（Hz） */
  rolloffHz: number;
  /** 高频能量比 0–1（亮度） */
  brightness: number;
  /** 谱平坦度 0–1（越接近 1 越接近噪声） */
  flatness: number;
  /** 谱不规则度 0–1（感知粗糙度近似） */
  roughness: number;
  /** 平均 RMS 0–1 */
  rms: number;
  /** 平均峰值因子（peak/rms） */
  crest: number;
  /** 平均正向谱通量（瞬态活跃度） */
  flux: number;
  /** 平均起始相对响度跃变 0–1（RMS 包络相对提升均值） */
  attack: number;
}

export interface MesoProfile {
  /** onset 密度（次/秒） */
  onsetDensity: number;
  /** 12 音级能量（归一化，和=1） */
  chroma: number[];
  /** 音高稳定性 0–1（chroma 熵的补） */
  pitchStability: number;
  /** 估计调性中心（MIDI） */
  tonic: number;
  /** 调性置信度 0–1 */
  tonicStrength: number;
  /** 立体声宽度 0–1（单声道=0，完全去相关=1） */
  stereoWidth: number;
  /** 响度动态范围（dB，p95–p05） */
  dynamicsDb: number;
}

export interface MacroProfile {
  /** 归一化密度漂移（每曲分段时间的线性斜率 / 均值） */
  densityDrift: number;
  brightnessDrift: number;
  tensionDrift: number;
  /** 自相似 recurrence 0–1 */
  recurrence: number;
  durationSec: number;
}

export interface ReferenceProfile {
  sourceName: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  micro: MicroProfile;
  meso: MesoProfile;
  macro: MacroProfile;
}

function hzToMidi(hz: number): number {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : 0;
}

// Krumhansl–Kessler 大调音高类轮廓（用于从 chroma 估计调性中心）
const KK_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];

export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    out[i] = s * inv;
  }
  return out;
}

/** 零延滞归一化互相关系数（-1..1） */
function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  if (den < 1e-9) return 0;
  return num / den;
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i];
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return 0;
  return (n * sxy - sx * sy) / den;
}

/** 从 12 维 chroma（无需预先归一化）估计音高稳定性（熵补） */
export function pitchStabilityFromChroma(chromaRaw: number[]): number {
  const total = chromaRaw.reduce((a, b) => a + b, 0) || 1;
  const maxEntropy = Math.log2(12);
  let entropy = 0;
  for (const v of chromaRaw) {
    const p = v / total;
    if (p > 1e-9) entropy -= p * Math.log2(p);
  }
  return Math.max(0, Math.min(1, 1 - entropy / maxEntropy));
}

/** 从 12 维 chroma 估计调性中心与置信度（KK 大调轮廓相关） */
export function estimateTonalCenter(chromaRaw: number[]): { tonic: number; tonicStrength: number } {
  const total = chromaRaw.reduce((a, b) => a + b, 0) || 1;
  const c = chromaRaw.map((v) => v / total);
  let bestScore = -Infinity;
  let bestPc = 0;
  for (let i = 0; i < 12; i++) {
    let score = 0;
    for (let pc = 0; pc < 12; pc++) score += c[(pc + i) % 12] * KK_PROFILE[pc];
    if (score > bestScore) { bestScore = score; bestPc = i; }
  }
  const kkMean = KK_PROFILE.reduce((a, b) => a + b, 0) / 12;
  const tonicStrength = Math.max(0, Math.min(1, (bestScore - kkMean) / 3));
  return { tonic: 48 + bestPc, tonicStrength };
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** 对单声道 PCM 做完整的参考特征分析。windowMs 控制微观窗长（默认 46ms）。 */
export function analyzeReference(
  channels: Float32Array[],
  sampleRate: number,
  sourceName = 'reference',
  windowMs = 46,
): ReferenceProfile {
  const mono = downmix(channels);
  const n = mono.length;
  const durationSec = n / sampleRate;
  const windowSize = Math.max(64, Math.round((windowMs / 1000) * sampleRate));
  const hop = Math.max(1, windowSize >> 1);

  const nyquist = sampleRate / 2;
  const highCut = Math.min(nyquist, 2000);

  // 逐帧提取
  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const brightness: number[] = [];
  const flatness: number[] = [];
  const roughness: number[] = [];
  const rmsArr: number[] = [];
  const crestArr: number[] = [];
  const fluxArr: number[] = [];
  const chromaAcc = new Float64Array(12);
  let prevMag: Float64Array | null = null;
  const frameChromas: number[][] = [];

  const win = new Float64Array(windowSize);
  for (let start = 0; start + windowSize <= n; start += hop) {
    // 拷贝 + 去直流
    let dc = 0;
    for (let i = 0; i < windowSize; i++) dc += mono[start + i];
    dc /= windowSize;
    for (let i = 0; i < windowSize; i++) win[i] = mono[start + i] - dc;
    // 原始 RMS 与峰值
    let sq = 0;
    let pk = 0;
    for (let i = 0; i < windowSize; i++) {
      const v = win[i];
      sq += v * v;
      if (Math.abs(v) > pk) pk = Math.abs(v);
    }
    const rms = Math.sqrt(sq / windowSize);
    rmsArr.push(rms);
    crestArr.push(rms > 1e-6 ? pk / rms : 0);

    hannWindow(win);
    const { magnitude, fftSize: fft } = magnitudeSpectrum(win, windowSize);
    const half = fft >> 1;

    let sum = 0;
    let wsum = 0;
    let total = 0;
    let energyHigh = 0;
    let energyTotal = 0;
    let geoLogSum = 0;
    let posCount = 0;
    for (let k = 0; k <= half; k++) {
      const m = magnitude[k];
      const f = (k * sampleRate) / fft;
      total += m;
      wsum += f * m;
      const e = m * m;
      energyTotal += e;
      if (f >= highCut) energyHigh += e;
      if (m > 1e-9) {
        geoLogSum += Math.log(m);
        posCount++;
      }
      // chroma（忽略 DC）
      if (k > 0 && f < nyquist) {
        const midi = hzToMidi(f);
        if (midi > 0 && midi < 108) {
          const pc = Math.round(midi) % 12;
          chromaAcc[pc] += m;
        }
      }
    }
    sum = total;
    const centroid = sum > 1e-9 ? wsum / sum : 0;
    centroids.push(centroid);

    // 滚降 85%
    let cum = 0;
    let rolloff = nyquist;
    for (let k = 0; k <= half; k++) {
      cum += magnitude[k] * magnitude[k];
      if (cum >= 0.85 * energyTotal) {
        rolloff = (k * sampleRate) / fft;
        break;
      }
    }
    rolloffs.push(rolloff);

    brightness.push(energyTotal > 1e-9 ? energyHigh / energyTotal : 0);

    // 谱平坦度（几何均值 / 算术均值）
    const arith = sum / (half + 1);
    const geo = posCount > 0 ? Math.exp(geoLogSum / posCount) : 0;
    flatness.push(arith > 1e-9 ? geo / arith : 0);

    // 谱不规则度（粗糙度近似）
    let irreg = 0;
    let magSum = 0;
    for (let k = 1; k <= half; k++) {
      irreg += Math.abs(magnitude[k] - magnitude[k - 1]);
      magSum += magnitude[k];
    }
    roughness.push(magSum > 1e-9 ? irreg / magSum : 0);

    // 谱通量（相对上一帧的正向差异）
    if (prevMag) {
      const minHalf = Math.min(prevMag.length, magnitude.length);
      let flux = 0;
      for (let k = 0; k < minHalf; k++) {
        const d = magnitude[k] - prevMag[k];
        if (d > 0) flux += d;
      }
      fluxArr.push(flux);
    }
    prevMag = magnitude;

    // 帧 chroma（用于 recurrence / 稳定性）
    const fmax = chromaAcc.reduce((a, b) => a + b, 0) || 1;
    frameChromas.push(Array.from(chromaAcc, (v) => v / fmax));
  }

  // onset 密度：基于帧 RMS 包络的正向相对跃变（对稳态纯音≈0，白噪声仅偶发）
  const fluxMean = fluxArr.length ? mean(fluxArr) : 0;
  let onsets = 0;
  let attackSum = 0;
  for (let i = 1; i < rmsArr.length; i++) {
    const prev = rmsArr[i - 1];
    const cur = rmsArr[i];
    const rise = cur - prev;
    if (prev > 1e-4 && rise > prev * 0.35) {
      onsets++;
      attackSum += Math.min(2, rise / prev);
    }
  }
  const onsetDensity = durationSec > 0 ? onsets / durationSec : 0;
  const attack = onsets > 0 ? Math.min(1, attackSum / onsets) : 0;

  // chroma 归一化
  const chromaTotal = chromaAcc.reduce((a, b) => a + b, 0) || 1;
  const chroma = Array.from(chromaAcc, (v) => v / chromaTotal);

  // 音高稳定性与调性中心（chroma 熵补 + KK 轮廓相关）
  const pitchStability = pitchStabilityFromChroma(chroma);
  const { tonic, tonicStrength } = estimateTonalCenter(chroma);

  // 立体声宽度（对双声道）
  let stereoWidth = 0;
  if (channels.length >= 2) {
    const c = Math.max(-1, Math.min(1, correlation(channels[0], channels[1])));
    stereoWidth = 1 - Math.abs(c);
  } else {
    stereoWidth = 0;
  }

  // 动态范围（帧 RMS，9 分位差 dB）
  const sortedRms = rmsArr.slice().sort((a, b) => a - b);
  const p05 = percentile(sortedRms, 5);
  const p95 = percentile(sortedRms, 95);
  const dynamicsDb = p95 > 1e-6 && p05 > 1e-6 ? 20 * Math.log10(p95 / p05) : 0;

  // 宏观：分段统计 + 线性漂移 + recurrence
  const segments = 8;
  const segLen = Math.max(1, Math.floor(frameChromas.length / segments) || 1);
  const segDensity: number[] = [];
  const segBrightness: number[] = [];
  const segTension: number[] = [];
  const segIdx: number[] = [];
  const segChroma: number[][] = [];
  for (let s = 0; s < segments; s++) {
    const a = s * segLen;
    const b = Math.min(frameChromas.length, a + segLen);
    if (a >= b) continue;
    segIdx.push(s);
    let sb = 0; let sr = 0; let count = 0;
    const sc = new Float64Array(12);
    for (let i = a; i < b; i++) {
      count++;
      const bl = brightness[i] ?? 0;
      const rg = roughness[i] ?? 0;
      sb += bl;
      sr += rg;
      for (let pc = 0; pc < 12; pc++) sc[pc] += frameChromas[i][pc];
    }
    segBrightness.push(sb / count);
    segTension.push(sr / count);
    // 密度用本窗口内 onset 数近似：直接用 RMS 均值作为响度密度替代
    const rr = rmsArr.slice(a, Math.min(rmsArr.length, b));
    segDensity.push(rr.length ? mean(rr) : 0);
    const st = sc.reduce((x, y) => x + y, 0) || 1;
    segChroma.push(Array.from(sc, (v) => v / st));
  }
  const normDrift = (ys: number[]) => {
    const m = mean(ys);
    if (segIdx.length < 2 || Math.abs(m) < 1e-9) return 0;
    return (linearSlope(segIdx, ys) / m) * (segIdx.length - 1);
  };
  const densityDrift = normDrift(segDensity);
  const brightnessDrift = normDrift(segBrightness);
  const tensionDrift = normDrift(segTension);

  // recurrence：相邻分段 chroma 的余弦相似度均值
  let rec = 0;
  if (segChroma.length >= 2) {
    let sumRec = 0;
    for (let i = 1; i < segChroma.length; i++) {
      const a = segChroma[i - 1];
      const b = segChroma[i];
      let dot = 0; let na = 0; let nb = 0;
      for (let k = 0; k < 12; k++) {
        dot += a[k] * b[k];
        na += a[k] * a[k];
        nb += b[k] * b[k];
      }
      const den = Math.sqrt(na * nb);
      sumRec += den > 1e-9 ? dot / den : 0;
    }
    rec = sumRec / (segChroma.length - 1);
  }

  const micro: MicroProfile = {
    centroidHz: mean(centroids),
    rolloffHz: mean(rolloffs),
    brightness: Math.max(0, Math.min(1, mean(brightness))),
    flatness: Math.max(0, Math.min(1, mean(flatness))),
    roughness: Math.max(0, Math.min(1, mean(roughness) / 4)),
    rms: Math.max(0, Math.min(1, mean(rmsArr))),
    crest: mean(crestArr),
    flux: fluxMean,
    attack: Math.max(0, Math.min(1, attack)),
  };

  const meso: MesoProfile = {
    onsetDensity,
    chroma,
    pitchStability,
    tonic,
    tonicStrength,
    stereoWidth: Math.max(0, Math.min(1, stereoWidth)),
    dynamicsDb,
  };

  const macro: MacroProfile = {
    densityDrift: clamp1(densityDrift),
    brightnessDrift: clamp1(brightnessDrift),
    tensionDrift: clamp1(tensionDrift),
    recurrence: Math.max(0, Math.min(1, rec)),
    durationSec,
  };

  return { sourceName, sampleRate, channels: channels.length, durationSec, micro, meso, macro };
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}