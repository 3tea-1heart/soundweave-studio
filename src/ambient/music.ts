/**
 * 音级与音感工具：供 energy / processes 共用。
 */

export const PC = (midi: number): number => ((midi % 12) + 12) % 12;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 音级集合升序去重 */
export function normalizeScale(pcs: number[]): number[] {
  return Array.from(new Set(pcs.map(PC))).sort((a, b) => a - b);
}

export function inScale(midi: number, scale: number[]): boolean {
  return normalizeScale(scale).includes(PC(midi));
}

/** 音级到最近 scale 音级的半音距离 */
export function distanceToScale(midi: number, scale: number[]): number {
  const pcs = normalizeScale(scale);
  const pc = PC(midi);
  let d = 12;
  for (const s of pcs) d = Math.min(d, Math.min(Math.abs(pc - s), 12 - Math.abs(pc - s)));
  return d;
}

/**
 * 找到最接近且落在 register 内的 scale 音（按距离排序取最近）。
 * 用于把随机游走吸附到音阶上。
 */
export function snapToScale(midi: number, scale: number[], register: { min: number; max: number }): number {
  const pcs = normalizeScale(scale);
  let best = midi;
  let bestDist = Infinity;
  for (let k = -2; k <= 2; k++) {
    for (const pc of pcs) {
      const cand = (Math.floor(midi / 12) + k) * 12 + pc;
      if (cand < register.min || cand > register.max) continue;
      const d = Math.abs(cand - midi);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
  }
  return clamp(best, register.min, register.max);
}

/**
 * 近似音感不协和度：基于两音高音级间隔的静态 dissonance 曲线。
 * 0 = 完全协和，1 = 极不协和。用于 energy 的 roughness/harmonicity 特征。
 * （近似，非严格 Plomp-Levelt；M3 参考分析再引入精细化特征。）
 */
const DISSONANCE: Record<number, number> = {
  0: 0.0, 1: 0.9, 2: 0.62, 3: 0.44, 4: 0.54, 5: 0.34,
  6: 0.82, 7: 0.22, 8: 0.48, 9: 0.26, 10: 0.66, 11: 0.78, 12: 0.12,
};

export function pairDissonance(a: number, b: number): number {
  const ic = Math.abs(a - b) % 12;
  return DISSONANCE[ic] ?? 0.5;
}

/** 当前发声集合的平均成对不协和度 */
export function meanDissonance(pitches: number[]): number {
  if (pitches.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pitches.length; i++) {
    for (let j = i + 1; j < pitches.length; j++) {
      sum += pairDissonance(pitches[i], pitches[j]);
      n++;
    }
  }
  return sum / n;
}

/** MIDI → 频率 Hz */
export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}