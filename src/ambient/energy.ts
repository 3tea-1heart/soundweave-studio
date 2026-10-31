/**
 * Evaluator（软能量）+ stochastic Selector（softmax/Boltzmann）+ Homeostasis。
 *
 * 特征（规格 §7）：
 *   density（密度）、dissonance（roughness/harmonicity）、brightness（亮度）、
 *   tonalStability（调性稳定）、repetition（重复惩罚）、novelty（新颖奖励）、silenceRatio（静默）。
 * 能量 = Σ 目标区间误差 · 权重 − novelty 奖励 + voice-leading 代价。
 * Selector 用温度做 Boltzmann 采样，因此不恒定取最低能量。
 */
import type { HomeostasisTarget, MusicEvent, StylePreset } from './types';
import { clamp, meanDissonance, normalizeScale } from './music';

export interface FeatureVector {
  density: number;
  dissonance: number;
  brightness: number;
  tonalStability: number;
  repetition: number;
  novelty: number;
  silenceRatio: number;
}

export interface SceneCtx {
  scale: number[];
  tempo: number;
  beatsPerBar: number;
  windowBeats: number;
}

const W = {
  density: 1.0,
  dissonance: 1.2,
  brightness: 0.5,
  tonalStability: 1.0,
  repetition: 0.9,
  silenceRatio: 0.6,
  noveltyTarget: 0.2,
  noveltyReward: 0.6,
  voiceLeading: 0.5,
};

/** 「跳过当前时间点」候选的基准能量偏移（过高则永不静默，过低则全天静默）。 */
export const SKIP_BIAS = 0.0;

function err(v: number, iv: { min: number; max: number }): number {
  if (v < iv.min) return iv.min - v;
  if (v > iv.max) return v - iv.max;
  return 0;
}

/** 归一化：每 10 秒音符数 → 0–1（以 30 个/10s 为满刻度） */
const DENSITY_FULL = 30;
const BRIGHT_LO = 48;
const BRIGHT_HI = 84;

export function computeFeatures(
  scene: MusicEvent[],
  candidate: MusicEvent | null,
  beat: number,
  ctx: SceneCtx,
): FeatureVector {
  const winStart = beat - ctx.windowBeats;

  // 窗口内已提交音符 + 候选
  let notes = scene.filter((e) => e.kind === 'Note' && e.beat + (e.duration ?? 0) > winStart && e.beat <= beat);
  if (candidate && candidate.kind === 'Note') notes = notes.concat(candidate);

  // 密度：每 10 秒平均
  const winSeconds = (ctx.windowBeats * 60) / ctx.tempo;
  const density = clamp((notes.length / Math.max(0.001, winSeconds)) * 10 / DENSITY_FULL, 0, 1);

  // 不协和度：当前发声音高集合（含候选）的成对均值
  const active = notes.filter((e) => e.kind === 'Note' && e.beat <= beat && e.beat + (e.duration ?? 0) > beat);
  const dissonance = active.length >= 2 ? clamp(meanDissonance(active.map((e) => e.pitch!)), 0, 1) : 0;

  // 亮度：窗口内平均音高归一化
  const pitched = notes.filter((e) => e.kind === 'Note' && Number.isFinite(e.pitch));
  const brightness = pitched.length
    ? clamp((pitched.reduce((s, e) => s + (e.pitch ?? 0), 0) / pitched.length - BRIGHT_LO) / (BRIGHT_HI - BRIGHT_LO), 0, 1)
    : 0;

  // 调性稳定：窗口内音符落在音阶内的比例
  const pcs = normalizeScale(ctx.scale);
  const tonalStability = pitched.length
    ? pitched.filter((e) => pcs.includes(((e.pitch ?? 0) % 12 + 12) % 12)).length / pitched.length
    : 1;

  // 重复惩罚：候选音高与最近 J 个已提交音高重复的比例
  const J = 12;
  let repetition = 0;
  if (candidate && candidate.kind === 'Note') {
    const cpc = ((candidate.pitch ?? 0) % 12 + 12) % 12;
    const history = scene.filter((e) => e.kind === 'Note').slice(-J);
    if (history.length) {
      repetition = history.filter((e) => ((e.pitch ?? 0) % 12 + 12) % 12 === cpc).length / history.length;
    }
  }

  // 新颖奖励：候选音级不在更长记忆中（L）的比例取反
  const L = 48;
  let novelty = 1;
  if (candidate && candidate.kind === 'Note') {
    const cpc = ((candidate.pitch ?? 0) % 12 + 12) % 12;
    const mem = scene.filter((e) => e.kind === 'Note').slice(-L);
    novelty = mem.length
      ? mem.filter((e) => ((e.pitch ?? 0) % 12 + 12) % 12 === cpc).length === 0 ? 1 : 0
      : 1;
  }

  // 静默比：窗口内无音符发声的时间占比（区间并集）
  const silenceRatio = silenceWithin(scene, candidate, winStart, beat);

  return { density, dissonance, brightness, tonalStability, repetition, novelty, silenceRatio };
}

function silenceWithin(scene: MusicEvent[], candidate: MusicEvent | null, winStart: number, winEnd: number): number {
  const span = Math.max(0.0001, winEnd - winStart);
  let intervals: Array<[number, number]> = [];
  for (const e of scene) {
    if (e.kind !== 'Note') continue;
    const s = Math.max(e.beat, winStart);
    const t = Math.min(e.beat + (e.duration ?? 0), winEnd);
    if (t > s) intervals.push([s, t]);
  }
  if (candidate && candidate.kind === 'Note') {
    const s = Math.max(candidate.beat, winStart);
    const t = Math.min(candidate.beat + (candidate.duration ?? 0), winEnd);
    if (t > s) intervals.push([s, t]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const iv of intervals) {
    if (!cur) cur = [iv[0], iv[1]];
    else if (iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
    else {
      total += cur[1] - cur[0];
      cur = [iv[0], iv[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return clamp(1 - total / span, 0, 1);
}

export function energyOf(f: FeatureVector, t: HomeostasisTarget, voiceLeadingCost: number): number {
  let e = 0;
  e += W.density * err(f.density, t.density);
  e += W.dissonance * err(f.dissonance, t.dissonance);
  e += W.brightness * err(f.brightness, t.brightness);
  e += W.tonalStability * err(f.tonalStability, t.tonalStability);
  e += W.repetition * err(f.repetition, t.repetition);
  e += W.silenceRatio * err(f.silenceRatio, t.silenceRatio);
  e += W.noveltyTarget * err(f.novelty, t.novelty);
  e -= W.noveltyReward * f.novelty;
  e += W.voiceLeading * voiceLeadingCost;
  return e;
}

/** 声部连线代价：候选音高与上一音高距离（半音，归一化 0–1）。 */
export function voiceLeadingCost(lastPitch: number | null, pitch: number | null): number {
  if (lastPitch === null || pitch === null) return 0;
  return clamp(Math.abs(pitch - lastPitch) / 12, 0, 1);
}

/**
 * softmax / Boltzmann 采样：温度越高越随机，越低越趋向最低能量。
 * 返回选中下标。使用传入 Rng 做无偏分类抽样，保证确定性。
 */
export function softmaxSample(energies: number[], temperature: number, rng: { next(): number }): number {
  const T = Math.max(1e-3, temperature);
  const maxE = Math.max(...energies);
  const exps = energies.map((e) => Math.exp(-(e - maxE) / T));
  const total = exps.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  let r = rng.next() * total;
  for (let i = 0; i < exps.length; i++) {
    r -= exps[i];
    if (r <= 0) return i;
  }
  return exps.length - 1;
}

/** 温度退火：从上限缓慢降到下限，先探索后收敛；确定性。 */
export function temperatureAt(step: number, total: number, preset: { temperature: { min: number; max: number } }): number {
  const { min, max } = preset.temperature;
  if (total <= 1) return (min + max) / 2;
  const progress = clamp(step / total, 0, 1);
  return min + (max - min) * Math.exp(-4 * progress);
}