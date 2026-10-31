/**
 * 用户 A/B 偏好适配（M6）。
 * 经典可解释的在线偏好学习：用户在两个生成变体（A/B）间二选一，
 * 系统按若干可感知维度（密度、亮度、不协和、调性稳定、速度、重复感）比较两个候选，
 * 累积「用户偏好的方向」（正=希望该维度更高，负=希望更低），再回补到 StylePreset 参数区。
 *
 * 小样本防过拟合：仅在样本数 ≥ 阈值且方向显著时应用偏好，避免把 1–2 次偶然点击当成喜好。
 * 变体生成复用 M4 的 mutatePreset，特征提取复用 M3/M4 的真实评估闭环（生成→渲染→分析），无 placeholder。
 */
import type { StylePreset } from './types';
import type { ReferenceProfile } from './analysis';
import { analyzeReference } from './analysis';
import { generateAmbient } from './generate';
import { renderAmbient } from './render';
import { mutatePreset } from './fitting';
import { Rng, seedString } from './rng';
import { clamp } from './music';

export type PreferenceDim = 'density' | 'brightness' | 'dissonance' | 'stability' | 'tempo' | 'recurrence';

export interface PreferenceFeatures {
  density: number;
  brightness: number;
  dissonance: number;
  stability: number;
  tempo: number;
  recurrence: number;
}

export interface PreferenceProfile {
  version: number;
  /** 每维偏好方向（-1..1，正=希望更高，负=希望更低） */
  direction: PreferenceFeatures;
  /** 每维累计样本数（置信度） */
  samples: PreferenceFeatures;
  totalComparisons: number;
}

const DIMS: PreferenceDim[] = ['density', 'brightness', 'dissonance', 'stability', 'tempo', 'recurrence'];

export function emptyPreference(): PreferenceProfile {
  const zeros = (): PreferenceFeatures => ({ density: 0, brightness: 0, dissonance: 0, stability: 0, tempo: 0, recurrence: 0 });
  return { version: 1, direction: zeros(), samples: zeros(), totalComparisons: 0 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 从参考轮廓 + 速度提取归一化感知特征（纯函数） */
export function preferenceFeaturesFromProfile(profile: ReferenceProfile, tempo: number): PreferenceFeatures {
  return {
    density: clamp01(profile.meso.onsetDensity / 4),
    brightness: clamp01(profile.micro.brightness),
    dissonance: clamp01(profile.micro.roughness),
    stability: clamp01(profile.meso.pitchStability),
    tempo: clamp01((tempo - 40) / 100),
    recurrence: clamp01(profile.macro.recurrence),
  };
}

export interface PreferenceEvaluateOptions {
  seed?: string | number;
  sampleRate?: number;
  seconds?: number;
}

/** 便捷封装：生成 + 渲染 + 分析一个候选，得到其感知特征与工程 */
export function preferenceFeaturesFromPreset(
  preset: StylePreset,
  opts: PreferenceEvaluateOptions = {},
): { features: PreferenceFeatures; project: ReturnType<typeof generateAmbient> } {
  const seed = opts.seed ?? 'pref-eval';
  const sampleRate = opts.sampleRate ?? 22050;
  const seconds = opts.seconds ?? 10;
  const project = generateAmbient({ preset, seed, durationSec: seconds });
  const rendered = renderAmbient(project, { sampleRate });
  const profile = analyzeReference(rendered.channels, sampleRate, preset.id);
  return { features: preferenceFeaturesFromProfile(profile, project.tempo), project };
}

/** 记录一次 A/B 选择（就地更新 profile 并返回，方便链式） */
export function recordPreference(
  profile: PreferenceProfile,
  a: PreferenceFeatures,
  b: PreferenceFeatures,
  winner: 'a' | 'b',
): PreferenceProfile {
  for (const d of DIMS) {
    const delta = winner === 'a' ? a[d] - b[d] : b[d] - a[d];
    const n = profile.samples[d] + 1;
    profile.direction[d] = clamp(profile.direction[d] + (clamp(delta, -1, 1) - profile.direction[d]) / n, -1, 1);
    profile.samples[d] = n;
  }
  profile.totalComparisons++;
  return profile;
}

/** 用 mutatePreset 生成一对差异化变体（确定性，同 seed 同结果） */
export function pairForComparison(preset: StylePreset, seed: string | number): { a: StylePreset; b: StylePreset } {
  const a = mutatePreset(preset, new Rng(seedString(seed) + ':pair:a'));
  const b = mutatePreset(preset, new Rng(seedString(seed) + ':pair:b'));
  return { a, b };
}

function shiftInterval(iv: { min: number; max: number }, delta: number, lo: number, hi: number): { min: number; max: number } {
  const x = clamp(iv.min + delta, lo, hi);
  const y = clamp(iv.max + delta, lo, hi);
  return x <= y ? { min: x, max: y } : { min: y, max: x };
}

const SIGNIFICANT_DIRECTION = 0.12;
const MIN_SAMPLES = 3;

/**
 * 把偏好方向回补到 StylePreset（返回新 preset + 可解释的改动描述）。
 * 仅在「方向显著且样本足够」时应用，避免小样本过拟合。
 */
export function applyPreference(preset: StylePreset, profile: PreferenceProfile): { preset: StylePreset; changes: string[] } {
  const p = JSON.parse(JSON.stringify(preset)) as StylePreset;
  const changes: string[] = [];
  const h = p.homeostasis;

  const active = (d: PreferenceDim): boolean =>
    Math.abs(profile.direction[d]) >= SIGNIFICANT_DIRECTION && profile.samples[d] >= MIN_SAMPLES;

  if (active('density')) {
    h.density = shiftInterval(h.density, profile.direction.density * 0.15, 0, 0.7);
    changes.push(`密度目标 ${profile.direction.density > 0 ? '上调' : '下调'}`);
  }
  if (active('brightness')) {
    h.brightness = shiftInterval(h.brightness, profile.direction.brightness * 0.15, 0, 1);
    changes.push(`亮度目标 ${profile.direction.brightness > 0 ? '上调' : '下调'}`);
  }
  if (active('dissonance')) {
    h.dissonance = shiftInterval(h.dissonance, profile.direction.dissonance * 0.12, 0, 0.8);
    changes.push(`不协和目标 ${profile.direction.dissonance > 0 ? '上调' : '下调'}`);
  }
  if (active('stability')) {
    h.tonalStability = shiftInterval(h.tonalStability, profile.direction.stability * 0.15, 0, 1);
    p.temperature = shiftInterval(p.temperature, -profile.direction.stability * 0.3, 0.2, 4);
    changes.push(`调性稳定性 ${profile.direction.stability > 0 ? '上调' : '下调'}（温度反向微调）`);
  }
  if (active('recurrence')) {
    h.repetition = shiftInterval(h.repetition, profile.direction.recurrence * 0.15, 0, 1);
    h.novelty = shiftInterval(h.novelty, -profile.direction.recurrence * 0.15, 0, 1);
    changes.push(`重复/主题性 ${profile.direction.recurrence > 0 ? '增强' : '减弱'}`);
  }
  if (active('tempo')) {
    p.tempo = shiftInterval(p.tempo, profile.direction.tempo * 10, 40, 140);
    changes.push(`速度区间 ${profile.direction.tempo > 0 ? '上调' : '下调'}`);
  }

  return { preset: p, changes };
}