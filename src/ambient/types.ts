/**
 * Generative Ambient 子系统的类型（对应规格 §3 三层表示之 Composition 层与 §4 统一事件模型）。
 * M1 仅产出 Note 事件；Chord/Texture/Drone/Noise/Sample 等 kind 预留给 M2。
 */
import type { InstrumentType } from '../core/types';

export const STYLE_SCHEMA_VERSION = 1;

export type EventKind =
  | 'Note' | 'Chord' | 'Control' | 'Texture' | 'Drone' | 'Noise'
  | 'Sample' | 'SilenceMarker' | 'StructuralMarker';

/** 事件可追溯到 Agent / Rule / seed（验收项）。 */
export interface RuleOrigin {
  agentId: string;
  ruleId: string;
  processId: string;
  seed: string;
}

export interface MusicEvent {
  kind: EventKind;
  /** 绝对拍 */
  beat: number;
  pitch?: number;
  duration?: number;
  velocity?: number;
  origin: RuleOrigin;
}

export interface Interval {
  min: number;
  max: number;
}

export type PitchProcessId = 'weighted-field' | 'bounded-walk' | 'irrational-rotation' | 'voice-leading';
export type RhythmProcessId = 'fixed-clock' | 'near-fixed-clock' | 'phase-drift' | 'renewal-poisson' | 'euclidean';

export interface PitchProcessSpec {
  id: PitchProcessId;
  /** weighted-field：各音级权重（长度 == scale 长度） */
  field?: number[];
  /** bounded-walk：半音步长（默认 2） */
  step?: number;
  /** irrational-rotation：旋转系数（默认黄金角近似） */
  rotation?: number;
  /** voice-leading：最大跳跃半音（默认 5） */
  maxLeap?: number;
}

export interface RhythmProcessSpec {
  id: RhythmProcessId;
  /** 固定/近似时值（拍） */
  interval?: number;
  /** 抖动幅度（拍，near-fixed / phase-drift） */
  jitter?: number;
  /** 相漂移周期（拍，phase-drift） */
  driftPeriod?: number;
  /** 泊松平均间隔（拍，renewal-poisson） */
  mean?: number;
  /** Euclidean 周期长度（拍）与脉冲数 */
  cycle?: number;
  pulses?: number;
  offset?: number;
}

export interface AgentSpec {
  id: string;
  role: 'drone' | 'texture' | 'melody' | 'bass' | 'chord' | 'noise';
  instrument: InstrumentType;
  /** 宿主内置预设 id */
  preset: string;
  /** MIDI 音区 */
  register: Interval;
  /** 指向 preset.scales 的音阶名 */
  scaleRef: string;
  pitch: PitchProcessSpec;
  rhythm: RhythmProcessSpec;
  velocity: Interval;
  duration: Interval;
  /** coupling：监听其它 agent 最近输出引导音区 */
  listensTo?: string[];
}

export interface HomeostasisTarget {
  /** 每 10 秒音符数归一化（0–1）后的目标区间 */
  density: Interval;
  dissonance: Interval;
  brightness: Interval;
  tonalStability: Interval;
  repetition: Interval;
  novelty: Interval;
  silenceRatio: Interval;
}

export interface WeakConstraint {
  id: string;
  feature: keyof HomeostasisTarget;
  weight: number;
  target: Interval;
}

export interface FreeDimension {
  id: string;
  label: string;
  min: number;
  max: number;
}

export type TextureKind = 'drone' | 'shimmer' | 'noise' | 'grain';

/**
 * 非 MIDI 纹理声部（M2 Sound/Texture 层）：由生成器直接合成一段无缝循环音频，
 * 切成背靠背的音频片段铺满全曲，得到一条真实的音频轨（区别于 MIDI 音符轨）。
 */
export interface TextureSpec {
  id: string;
  kind: TextureKind;
  /** 相对调性中心的基频半音偏移 */
  baseOffset: number;
  /** 音量 0–1 */
  volume: number;
}

/**
 * StylePreset：不是固定 pattern，而是参数分布 / 关系规则 / 软约束。
 * 分层：invariants（硬不变式）+ weakConstraints（软约束）+ freeDimensions（自由维度）。
 */
export interface StylePreset {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  /** 硬不变量（生成结果必须满足，由 generate 强制） */
  invariants: string[];
  tempo: Interval;
  /** 默认时长（秒），M1 默认 ≥5 分钟 */
  durationSec: number;
  timeSig: [number, number];
  /** 调性中心（MIDI） */
  tonalCenter: number;
  scales: Record<string, number[]>;
  agents: AgentSpec[];
  /** 非 MIDI 纹理声部（可选）；每个元素合成一条音频轨 */
  texture?: TextureSpec[];
  homeostasis: HomeostasisTarget;
  weakConstraints: WeakConstraint[];
  freeDimensions: FreeDimension[];
  temperature: Interval;
}