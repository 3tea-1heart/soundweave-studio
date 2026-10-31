/**
 * 参考汇总与手工映射（M3 ReferenceProfile → StylePreset）。
 * 多首参考先聚合出共同特征与不确定度，再把特征映射成可编辑 StylePreset：
 * 亮度/粗糙度/onset 密度/调性稳定性/recurrence 分别驱动稳态目标与声部进程选择。
 * 这是「可解释的手工映射」，逆拟合与 QD 搜索在 M4 接入。
 */
import type { ReferenceProfile, MicroProfile, MesoProfile, MacroProfile } from './analysis';
import { estimateTonalCenter, pitchStabilityFromChroma } from './analysis';
import type { StylePreset, AgentSpec, TextureSpec, HomeostasisTarget, TextureKind } from './types';
import { STYLE_SCHEMA_VERSION } from './types';

export interface AggregatedProfile {
  count: number;
  /** 跨参考一致性 0–1（1=高度一致，0=分歧大/不确定） */
  certainty: number;
  durationSec: number;
  micro: MicroProfile;
  microStd: { brightness: number; roughness: number; centroidHz: number };
  meso: MesoProfile;
  mesoStd: { onsetDensity: number; pitchStability: number; stereoWidth: number };
  macro: MacroProfile;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: number[], m?: number): number {
  if (xs.length < 2) return 0;
  const mm = m ?? mean(xs);
  let s = 0;
  for (const x of xs) s += (x - mm) * (x - mm);
  return Math.sqrt(s / xs.length);
}

function cv(xs: number[]): number {
  const m = mean(xs);
  return Math.abs(m) > 1e-9 ? std(xs, m) / Math.abs(m) : 0;
}

function meanChroma(profiles: ReferenceProfile[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (const p of profiles) for (let i = 0; i < 12; i++) out[i] += p.meso.chroma[i] / profiles.length;
  return out;
}

export function aggregateReferences(profiles: ReferenceProfile[]): AggregatedProfile {
  const count = Math.max(1, profiles.length);
  const chroma = meanChroma(profiles);
  const onsetDensities = profiles.map((p) => p.meso.onsetDensity);
  const stabilities = profiles.map((p) => p.meso.pitchStability);
  const widths = profiles.map((p) => p.meso.stereoWidth);
  const brightness = profiles.map((p) => p.micro.brightness);
  const roughness = profiles.map((p) => p.micro.roughness);
  const centroids = profiles.map((p) => p.micro.centroidHz);
  const dynamics = profiles.map((p) => p.meso.dynamicsDb);
  const recurrences = profiles.map((p) => p.macro.recurrence);

  const { tonic, tonicStrength } = estimateTonalCenter(chroma);

  // 一致性：关键特征变异系数的均值 → 0..1
  const cvs = [cv(brightness), cv(roughness), cv(onsetDensities), cv(stabilities), cv(recurrences)];
  const certainty = Math.max(0, Math.min(1, 1 - mean(cvs)));

  const micro: MicroProfile = {
    centroidHz: mean(centroids),
    rolloffHz: mean(profiles.map((p) => p.micro.rolloffHz)),
    brightness: clamp01(mean(brightness)),
    flatness: clamp01(mean(profiles.map((p) => p.micro.flatness))),
    roughness: clamp01(mean(roughness)),
    rms: clamp01(mean(profiles.map((p) => p.micro.rms))),
    crest: mean(profiles.map((p) => p.micro.crest)),
    flux: mean(profiles.map((p) => p.micro.flux)),
    attack: clamp01(mean(profiles.map((p) => p.micro.attack))),
  };
  const meso: MesoProfile = {
    onsetDensity: mean(onsetDensities),
    chroma,
    pitchStability: pitchStabilityFromChroma(chroma),
    tonic,
    tonicStrength,
    stereoWidth: clamp01(mean(widths)),
    dynamicsDb: mean(dynamics),
  };
  const macro: MacroProfile = {
    densityDrift: mean(profiles.map((p) => p.macro.densityDrift)),
    brightnessDrift: mean(profiles.map((p) => p.macro.brightnessDrift)),
    tensionDrift: mean(profiles.map((p) => p.macro.tensionDrift)),
    recurrence: clamp01(mean(recurrences)),
    durationSec: mean(profiles.map((p) => p.macro.durationSec)),
  };

  return {
    count,
    certainty,
    durationSec: Math.max(30, Math.round(macro.durationSec)),
    micro,
    microStd: { brightness: std(brightness), roughness: std(roughness), centroidHz: std(centroids) },
    meso,
    mesoStd: { onsetDensity: std(onsetDensities), pitchStability: std(stabilities), stereoWidth: std(widths) },
    macro,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const INVARIANTS = [
  '音高落在各声部音区范围内',
  '时长与力度为有限正数',
  '无 NaN / ±Infinity',
  '每个事件可追溯到 Agent/Rule/seed',
];

const SCALES: Record<string, number[]> = {
  'pent-minor': [0, 3, 5, 7, 10],
  'pent-major': [0, 2, 4, 7, 9],
  'dorian': [0, 2, 3, 5, 7, 9, 10],
  'lydian': [0, 2, 4, 6, 7, 9, 11],
};

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export interface PresetFromProfileOptions {
  /** 预设名；缺省由特征自动命名 */
  name?: string;
  id?: string;
}

function pickScale(agg: AggregatedProfile): string {
  const c = agg.meso.chroma;
  const tonicPc = agg.meso.tonic % 12;
  const rel = (deg: number) => c[(tonicPc + deg) % 12];
  const minorThird = rel(3);
  const majorThird = rel(4);
  const sixth = rel(9);
  const second = rel(2);
  if (majorThird > minorThird * 1.3) return 'pent-major';
  if (second > 0.11 && sixth > 0.12) return 'dorian';
  return 'pent-minor';
}

function pickTexture(agg: AggregatedProfile): TextureKind {
  const { roughness, brightness } = agg.micro;
  if (roughness >= 0.45) return 'noise';
  if (brightness >= 0.42) return 'shimmer';
  if (agg.meso.pitchStability < 0.55 && agg.macro.recurrence < 0.4) return 'grain';
  return 'drone';
}

/** 由聚合特征手工映射为 StylePreset（可解释、确定、可序列化） */
export function aggregatedToPreset(agg: AggregatedProfile, opts: PresetFromProfileOptions = {}): StylePreset {
  const density01 = clamp01(agg.meso.onsetDensity / 4);
  const brightness = agg.micro.brightness;
  const roughness = agg.micro.roughness;
  const stability = agg.meso.pitchStability;
  const recurrence = agg.macro.recurrence;
  const tonic = clampInt(agg.meso.tonic, 36, 66);
  const scaleName = pickScale(agg);
  const scales: Record<string, number[]> = {};
  for (const k of Object.keys(SCALES)) scales[k] = SCALES[k];

  const tempoCenter = clampInt(Math.round(46 + density01 * 50), 50, 96);
  const tempo: [number, number] = [Math.max(40, tempoCenter - 10), tempoCenter + 15];

  // 从 chroma 侧写音高权重（相对 tonic 的音级能量 → 权重场）
  const scaleDegrees = SCALES[scaleName];
  const field = scaleDegrees.map((deg) => 1 + 3.5 * (agg.meso.chroma[(tonic + deg) % 12] ?? 0));

  const bright = brightness >= 0.45;
  const padPreset = bright ? 'pad-warm' : 'pad-dark';
  const voicePreset = bright ? 'ep-soft' : 'piano-soft';

  const agents: AgentSpec[] = [
    {
      id: 'drone',
      role: 'drone',
      instrument: 'synth',
      preset: padPreset,
      register: { min: clampInt(tonic - 14, 33, 55), max: clampInt(tonic - 6, 33, 60) },
      scaleRef: scaleName,
      pitch: { id: 'voice-leading', maxLeap: 2 },
      rhythm: { id: 'fixed-clock', interval: 16 },
      velocity: { min: 0.14, max: 0.26 },
      duration: { min: 12, max: 16 },
    },
    {
      id: 'voice',
      role: density01 >= 0.35 ? 'melody' : 'texture',
      instrument: bright ? 'ep' : 'piano',
      preset: voicePreset,
      register: { min: clampInt(tonic, 36, 72), max: clampInt(tonic + 19, 48, 96) },
      scaleRef: scaleName,
      pitch: { id: 'weighted-field', field },
      rhythm: density01 < 0.18 ? { id: 'renewal-poisson', mean: 7 } : { id: 'phase-drift', interval: 1.4, jitter: 0.3, driftPeriod: 96 },
      velocity: { min: 0.16, max: 0.32 },
      duration: density01 < 0.18 ? { min: 2, max: 6 } : { min: 0.5, max: 1.6 },
      listensTo: ['drone'],
    },
  ];
  if (density01 >= 0.22) {
    agents.push({
      id: 'bass',
      role: 'bass',
      instrument: 'bass',
      preset: 'bass-deep',
      register: { min: clampInt(tonic - 26, 28, 40), max: clampInt(tonic - 14, 33, 45) },
      scaleRef: scaleName,
      pitch: { id: 'weighted-field', field: scaleDegrees.map((deg) => 1 + 2.5 * (agg.meso.chroma[(tonic + deg) % 12] ?? 0)) },
      rhythm: { id: 'euclidean', cycle: 16, pulses: density01 >= 0.5 ? 6 : 4 },
      velocity: { min: 0.28, max: 0.45 },
      duration: { min: 2, max: 4 },
    });
  }

  const homeostasis: HomeostasisTarget = {
    density: { min: Math.max(0.02, density01 - 0.15), max: Math.min(0.6, density01 + 0.25) },
    dissonance: { min: 0, max: clamp01(roughness * 1.4 + 0.05) },
    brightness: { min: clamp01(brightness - 0.25), max: clamp01(brightness + 0.2) },
    tonalStability: { min: Math.max(0, Math.min(1, stability - 0.18)), max: 1 },
    repetition: { min: 0, max: clamp01(recurrence + 0.1) },
    novelty: { min: 0.3, max: 1 },
    silenceRatio: { min: clamp01(0.8 - density01), max: 0.9 },
  };

  const texture: TextureSpec[] = [{
    id: 'ref-texture',
    kind: pickTexture(agg),
    baseOffset: pickTexture(agg) === 'grain' ? 12 : pickTexture(agg) === 'shimmer' ? 0 : -12,
    volume: clamp01(0.12 + agg.micro.rms * 0.4),
  }];

  const featureHash = hashString(
    [agg.count, Math.round(brightness * 100), Math.round(roughness * 100), Math.round(density01 * 100),
      Math.round(stability * 100), tonic, scaleName].join('|'),
  );
  const id = opts.id ?? `ref-${featureHash}`;
  const name = opts.name ?? `参考衍生 · ${scaleName} ${tonic}`;

  return {
    schemaVersion: STYLE_SCHEMA_VERSION,
    id,
    name,
    description: `由 ${agg.count} 首参考聚合推导（一致性 ${(agg.certainty * 100).toFixed(0)}%）`,
    invariants: INVARIANTS,
    tempo: { min: tempo[0], max: tempo[1] },
    durationSec: clampInt(agg.durationSec, 60, 300),
    timeSig: [4, 4],
    tonalCenter: tonic,
    scales,
    agents,
    texture,
    homeostasis,
    weakConstraints: [
      { id: 'silence', feature: 'silenceRatio', weight: 1, target: homeostasis.silenceRatio },
      { id: 'density', feature: 'density', weight: 1, target: homeostasis.density },
    ],
    freeDimensions: [
      { id: 'tempo', label: '速度', min: tempo[0], max: tempo[1] },
      { id: 'brightness', label: '亮度', min: 0, max: 1 },
    ],
    temperature: { min: 0.6, max: 2.2 },
  };
}

/** 完整流水线：多首参考 → 聚合 → StylePreset */
export function referencesToPreset(profiles: ReferenceProfile[], opts: PresetFromProfileOptions = {}): StylePreset {
  return aggregatedToPreset(aggregateReferences(profiles), opts);
}

function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}