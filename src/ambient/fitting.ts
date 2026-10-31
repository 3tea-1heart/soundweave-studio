/**
 * 逆拟合 + Quality Diversity（M4）。
 * 目标：不保留单一 best 参数集，而是以 MAP-Elites 思路维护一个 archive，
 * 按行为特征（onset 密度、亮度、调性稳定性、纹理粗糙度）分箱，每箱保留
 * 与参考特征距离最小的可接受解释，从而得到「一组可接受的 rule/parameter 族」。
 *
 * 评估闭环是诚实且可解释的：候选 StylePreset → 生成 → 离线渲染 → analyzeReference → 特征距离。
 * 变异算子只在数值型自由参数上随机扰动，保证候选始终是合法的、可序列化的 StylePreset。
 * 小样本不确定度（1–3 首参考）的体现：由 M3 聚合出的 certainty 决定 archive 的接受阈值，
 * 低一致性时接受更宽，避免把单曲偶然特征当成 invariant。
 */
import type { StylePreset, Interval } from './types';
import type { AggregatedProfile } from './reference';
import { aggregatedToPreset } from './reference';
import { analyzeReference, type ReferenceProfile } from './analysis';
import { generateAmbient } from './generate';
import { renderAmbient } from './render';
import { Rng, seedString } from './rng';

export interface FitOptions {
  seed?: string | number;
  /** 评估预算（变异候选次数）；默认 80 */
  iterations?: number;
  /** 评估用渲染/分析采样率；默认 22050（Nyquist 覆盖到 11kHz，足够纹理频谱特征） */
  sampleRate?: number;
  /** 评估用时长（秒）；默认 10 */
  evaluateSeconds?: number;
  /** 初始候选（缺省用 M3 手工映射 aggregatedToPreset） */
  initialPreset?: StylePreset;
  name?: string;
  id?: string;
  /** 初始随机种子候选数；默认 6 */
  initialSeeds?: number;
}

export interface FitElite {
  preset: StylePreset;
  /** 评估时分析出的特征（可解释出为什么靠近目标） */
  features: ReferenceProfile;
  distance: number;
  /** MAP-Elites 行为特征箱位 [density, brightness, stability, roughness] */
  bin: number[];
}

export interface FitResult {
  target: AggregatedProfile;
  baseline: FitElite;
  best: FitElite;
  /** archive 全部 elites，按 distance 升序 */
  elites: FitElite[];
  evaluationCount: number;
  /** archive 覆盖的箱位数 */
  occupiedBins: number;
}

// ----------------------------------------------------------------- 行为分箱边界
const DENSITY_EDGES = [0, 0.4, 1.2, 2.5, Infinity];
const BRIGHT_EDGES = [0, 0.3, 0.5, 0.7, 1.001];
const STAB_EDGES = [0, 0.4, 0.7, 0.9, 1.001];
const ROUGH_EDGES = [0, 0.12, 0.25, 0.45, 1.001];

function binIndex(v: number, edges: number[]): number {
  for (let i = 0; i < edges.length - 1; i++) if (v < edges[i + 1]) return i;
  return edges.length - 2;
}

function behaviorBin(f: ReferenceProfile): number[] {
  return [
    binIndex(f.meso.onsetDensity, DENSITY_EDGES),
    binIndex(f.micro.brightness, BRIGHT_EDGES),
    binIndex(f.meso.pitchStability, STAB_EDGES),
    binIndex(f.micro.roughness, ROUGH_EDGES),
  ];
}

// ----------------------------------------------------------------- 特征距离
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 候选特征与目标聚合特征的归一化加权距离（越小越接近） */
export function profileDistance(p: ReferenceProfile, t: AggregatedProfile): number {
  const densityN = clamp01(p.meso.onsetDensity / 4) - clamp01(t.meso.onsetDensity / 4);
  let chromaL1 = 0;
  for (let i = 0; i < 12; i++) chromaL1 += Math.abs(p.meso.chroma[i] - t.meso.chroma[i]);
  return (
    1.0 * Math.abs(p.micro.brightness - t.micro.brightness) +
    1.0 * Math.abs(p.micro.roughness - t.micro.roughness) +
    0.9 * Math.abs(densityN) +
    0.8 * Math.abs(p.meso.pitchStability - t.meso.pitchStability) +
    0.6 * Math.abs(p.macro.recurrence - t.macro.recurrence) +
    0.5 * (chromaL1 / 2) +
    0.4 * Math.abs(p.micro.flatness - t.micro.flatness) +
    0.3 * Math.abs((p.micro.centroidHz - t.micro.centroidHz) / 20000) +
    0.2 * Math.abs(p.meso.stereoWidth - t.meso.stereoWidth)
  );
}

// ----------------------------------------------------------------- 变异算子
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 扰动区间，保持 min<=max 且落在 [lo,hi] */
function perturbInterval(iv: Interval, rng: Rng, dx: number, lo: number, hi: number): Interval {
  const a = clamp(iv.min + rng.uniform(-dx, dx), lo, hi);
  const b = clamp(iv.max + rng.uniform(-dx, dx), lo, hi);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

function mutateField(field: number[], rng: Rng): number[] {
  return field.map((w) => Math.max(0.1, w * (0.75 + rng.next() * 0.5)));
}

function mutateRhythm(rhythm: StylePreset['agents'][number]['rhythm'], rng: Rng): void {
  if (rhythm.id === 'euclidean' && rhythm.pulses !== undefined) {
    rhythm.pulses = clamp(rhythm.pulses + rng.int(-1, 1), 3, 7);
  } else if ((rhythm.id === 'fixed-clock' || rhythm.id === 'near-fixed-clock') && rhythm.interval !== undefined) {
    rhythm.interval = Math.max(1, rhythm.interval + rng.uniform(-2, 2));
  } else if (rhythm.id === 'phase-drift' && rhythm.interval !== undefined) {
    rhythm.interval = Math.max(0.2, rhythm.interval + rng.uniform(-0.2, 0.2));
    if (rhythm.jitter !== undefined) rhythm.jitter = Math.max(0, rhythm.jitter + rng.uniform(-0.1, 0.1));
  } else if (rhythm.id === 'renewal-poisson' && rhythm.mean !== undefined) {
    rhythm.mean = Math.max(1, rhythm.mean + rng.uniform(-2, 2));
  }
}

/** 在数值型自由参数上随机扰动，产出仍合法的 StylePreset（确定性） */
export function mutatePreset(preset: StylePreset, rng: Rng): StylePreset {
  const p = JSON.parse(JSON.stringify(preset)) as StylePreset;
  const nMut = rng.int(2, 4);
  for (let i = 0; i < nMut; i++) {
    switch (rng.int(0, 10)) {
      case 0:
        p.tempo = perturbInterval(p.tempo, rng, 6, 40, 140);
        break;
      case 1:
        p.tonalCenter = clamp(p.tonalCenter + rng.int(-2, 2), 36, 66);
        break;
      case 2:
        p.homeostasis.density = perturbInterval(p.homeostasis.density, rng, 0.06, 0.02, 0.7);
        break;
      case 3:
        p.homeostasis.brightness = perturbInterval(p.homeostasis.brightness, rng, 0.1, 0, 1);
        break;
      case 4:
        p.homeostasis.silenceRatio = perturbInterval(p.homeostasis.silenceRatio, rng, 0.08, 0, 0.95);
        break;
      case 5:
        for (const a of p.agents) {
          if (a.pitch.id === 'weighted-field' && a.pitch.field) a.pitch.field = mutateField(a.pitch.field, rng);
        }
        break;
      case 6:
        for (const a of p.agents) mutateRhythm(a.rhythm, rng);
        break;
      case 7:
        for (const a of p.agents) a.velocity = perturbInterval(a.velocity, rng, 0.06, 0.05, 1);
        break;
      case 8:
        for (const a of p.agents) a.duration = perturbInterval(a.duration, rng, 0.5, 0.05, 30);
        break;
      case 9:
        for (const t of p.texture ?? []) {
          t.volume = clamp(t.volume + rng.uniform(-0.12, 0.12), 0.05, 1);
          t.baseOffset = clamp(t.baseOffset + rng.int(-2, 2), -24, 24);
        }
        break;
      default:
        p.temperature = perturbInterval(p.temperature, rng, 0.3, 0.2, 4);
    }
  }
  return p;
}

// ----------------------------------------------------------------- 主循环
export function fitPreset(target: AggregatedProfile, opts: FitOptions = {}): FitResult {
  const seed = typeof opts.seed === 'number' ? String(opts.seed >>> 0) : String(opts.seed ?? 'fit');
  const rng = new Rng(seed);
  const sampleRate = opts.sampleRate ?? 22050;
  const evaluateSeconds = opts.evaluateSeconds ?? 10;
  const iterations = opts.iterations ?? 80;

  let evalCount = 0;
  const evaluate = (preset: StylePreset): FitElite => {
    const genSeed = `${seed}:eval:${evalCount++}`;
    const project = generateAmbient({ preset, seed: genSeed, durationSec: evaluateSeconds });
    const rendered = renderAmbient(project, { sampleRate });
    const features = analyzeReference(rendered.channels, sampleRate, preset.id);
    return { preset, features, distance: profileDistance(features, target), bin: behaviorBin(features) };
  };

  const baselinePreset = opts.initialPreset ?? aggregatedToPreset(target, { name: opts.name, id: opts.id });
  const baseline = evaluate(baselinePreset);

  const archive = new Map<string, FitElite>();
  const archiveNew = (elite: FitElite) => {
    const k = elite.bin.join('_');
    const old = archive.get(k);
    if (!old || elite.distance < old.distance) archive.set(k, elite);
  };
  archiveNew(baseline);

  // 初始种子候选（对 baseline 的变异，扩大初始覆盖面）
  const initialSeeds = opts.initialSeeds ?? 6;
  for (let i = 0; i < initialSeeds; i++) archiveNew(evaluate(mutatePreset(baselinePreset, rng)));

  // MAP-Elites 主循环：从 archive 随机选父本变异，或从 baseline 变异（保持探索）
  const elitesArray = () => Array.from(archive.values());
  for (let it = 0; it < iterations; it++) {
    const useArchive = archive.size > 0 && rng.chance(0.5);
    const parent = useArchive ? elitesArray()[rng.int(0, archive.size - 1)].preset : baselinePreset;
    archiveNew(evaluate(mutatePreset(parent, rng)));
  }

  const elites = elitesArray().sort((a, b) => a.distance - b.distance);
  return {
    target,
    baseline,
    best: elites[0],
    elites,
    evaluationCount: evalCount,
    occupiedBins: archive.size,
  };
}