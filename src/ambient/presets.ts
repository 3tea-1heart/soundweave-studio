/**
 * 内置 StylePreset（≥4 个，算法互不相同）。
 * 每个预设用不同的 pitch/rhythm 进程组合表达不同音乐行为，
 * 不是固定 pattern，而是参数分布 + 软约束 + 稳态目标。
 */
import type { StylePreset, AgentSpec, HomeostasisTarget, WeakConstraint, TextureSpec } from './types';
import { STYLE_SCHEMA_VERSION } from './types';

const INVARIANTS = [
  '音高落在各声部音区范围内',
  '时长与力度为有限正数',
  '无 NaN / ±Infinity',
  '每个事件可追溯到 Agent/Rule/seed',
];

function Ht(density: [number, number], dissonance: [number, number], brightness: [number, number], tonalStability: [number, number], repetition: [number, number], novelty: [number, number], silenceRatio: [number, number]): HomeostasisTarget {
  return {
    density: { min: density[0], max: density[1] },
    dissonance: { min: dissonance[0], max: dissonance[1] },
    brightness: { min: brightness[0], max: brightness[1] },
    tonalStability: { min: tonalStability[0], max: tonalStability[1] },
    repetition: { min: repetition[0], max: repetition[1] },
    novelty: { min: novelty[0], max: novelty[1] },
    silenceRatio: { min: silenceRatio[0], max: silenceRatio[1] },
  };
}

function A(
  id: string,
  role: AgentSpec['role'],
  instrument: AgentSpec['instrument'],
  preset: string,
  register: [number, number],
  scaleRef: string,
  pitch: AgentSpec['pitch'],
  rhythm: AgentSpec['rhythm'],
  velocity: [number, number],
  duration: [number, number],
  listensTo?: string[],
): AgentSpec {
  return {
    id, role, instrument, preset,
    register: { min: register[0], max: register[1] },
    scaleRef, pitch, rhythm,
    velocity: { min: velocity[0], max: velocity[1] },
    duration: { min: duration[0], max: duration[1] },
    listensTo,
  };
}

const SCALES = {
  'pent-minor': [0, 3, 5, 7, 10],
  'pent-major': [0, 2, 4, 7, 9],
  'dorian': [0, 2, 3, 5, 7, 9, 10],
  'lydian': [0, 2, 4, 6, 7, 9, 11],
  'aeolian': [0, 2, 3, 5, 7, 8, 10],
  'hirajoshi': [0, 2, 3, 7, 8],
};

function base(id: string, name: string, description: string, tempo: [number, number], tonalCenter: number, scaleNames: string[], agents: AgentSpec[], ht: HomeostasisTarget, weak: WeakConstraint[], texture?: TextureSpec[]): StylePreset {
  const scales: Record<string, number[]> = {};
  for (const s of scaleNames) scales[s] = SCALES[s as keyof typeof SCALES] ?? SCALES['pent-minor'];
  return {
    schemaVersion: STYLE_SCHEMA_VERSION,
    id, name, description,
    invariants: INVARIANTS,
    tempo: { min: tempo[0], max: tempo[1] },
    durationSec: 300,
    timeSig: [4, 4],
    tonalCenter,
    scales,
    agents,
    texture,
    homeostasis: ht,
    weakConstraints: weak,
    freeDimensions: [
      { id: 'tempo', label: '速度', min: tempo[0], max: tempo[1] },
      { id: 'brightness', label: '亮度', min: 0, max: 1 },
    ],
    temperature: { min: 0.6, max: 2.4 },
  };
}

// ----------------------------------------------------------------- 稀疏雾霭 Sparse Fog —— 稀疏长音 + 零散点缀
const sparseFog = base(
  'sparse-fog', '稀疏雾霭 Sparse Fog', '极疏的持续低音与零散高音点缀，高静默比。',
  [55, 70], 50, ['pent-minor'],
  [
    A('drone', 'drone', 'synth', 'pad-dark', [45, 57], 'pent-minor',
      { id: 'voice-leading', maxLeap: 2 },
      { id: 'fixed-clock', interval: 16 },
      [0.18, 0.3], [12, 16]),
    A('sparkle', 'melody', 'piano', 'piano-soft', [64, 82], 'pent-minor',
      { id: 'weighted-field', field: [1, 0.4, 1.2, 0.6, 0.9] },
      { id: 'renewal-poisson', mean: 7 },
      [0.12, 0.28], [2, 6], ['drone']),
  ],
  Ht([0.04, 0.2], [0, 0.3], [0.2, 0.6], [0.7, 1], [0, 0.3], [0.3, 1], [0.5, 0.9]),
  [{ id: 'rs', feature: 'silenceRatio', weight: 1.2, target: { min: 0.5, max: 0.9 } }],
  [{ id: 'drone-bed', kind: 'drone', baseOffset: -12, volume: 0.5 }],
);

// ----------------------------------------------------------------- 相位花园 Phase Garden —— 脉冲感琶音 + 相位漂移
const phaseGarden = base(
  'phase-garden', '相位花园 Phase Garden', '相位缓慢漂移的脉冲琶音，层叠微光铺底。',
  [82, 100], 57, ['pent-major'],
  [
    A('pulse', 'melody', 'synth', 'lead-glass', [72, 84], 'pent-major',
      { id: 'irrational-rotation' },
      { id: 'phase-drift', interval: 1.2, jitter: 0.25, driftPeriod: 96 },
      [0.35, 0.6], [0.5, 1.6]),
    A('glimmer', 'texture', 'synth', 'pad-shimmer', [57, 69], 'pent-major',
      { id: 'bounded-walk', step: 2 },
      { id: 'near-fixed-clock', interval: 6, jitter: 0.6 },
      [0.14, 0.24], [4, 8]),
    A('floor', 'bass', 'bass', 'bass-sub', [33, 40], 'pent-major',
      { id: 'weighted-field', field: [1.4, 0.3, 0.5, 0.4, 0.8] },
      { id: 'euclidean', cycle: 16, pulses: 5 },
      [0.3, 0.5], [2, 4]),
  ],
  Ht([0.25, 0.55], [0, 0.4], [0.3, 0.7], [0.6, 1], [0, 0.4], [0.3, 1], [0.05, 0.4]),
  [{ id: 'sp', feature: 'density', weight: 1, target: { min: 0.25, max: 0.55 } }],
  [{ id: 'shimmer-wash', kind: 'shimmer', baseOffset: 0, volume: 0.32 }],
);

// ----------------------------------------------------------------- 静室 Still Room —— 近乎静止的长和弦 + 极低音
const stillRoom = base(
  'still-room', '静室 Still Room', '近乎静止的长音和弦与极低音持续，高静默。',
  [48, 58], 48, ['dorian'],
  [
    A('bed', 'chord', 'synth', 'pad-choir', [48, 64], 'dorian',
      { id: 'voice-leading', maxLeap: 3 },
      { id: 'fixed-clock', interval: 32 },
      [0.15, 0.26], [24, 30]),
    A('root', 'bass', 'bass', 'bass-deep', [33, 45], 'dorian',
      { id: 'weighted-field', field: [2, 0.3, 0.5, 0.4, 0.7, 0.5, 0.6] },
      { id: 'fixed-clock', interval: 64 },
      [0.16, 0.3], [32, 44]),
  ],
  Ht([0.02, 0.12], [0, 0.3], [0.15, 0.5], [0.7, 1], [0, 0.3], [0.3, 1], [0.55, 0.9]),
  [{ id: 'ds', feature: 'silenceRatio', weight: 1.4, target: { min: 0.55, max: 0.9 } }],
  [{ id: 'room-tone', kind: 'noise', baseOffset: -12, volume: 0.2 }],
);

// ----------------------------------------------------------------- 五声音阶天气 Pentatonic Weather —— 走势旋律 + 持续铺底
const pentatonicWeather = base(
  'pentatonic-weather', '五声音阶天气 Pentatonic Weather', '五声音阶上的随机走势旋律，漂浮于温暖铺底之上。',
  [70, 88], 52, ['pent-minor', 'lydian'],
  [
    A('walk', 'melody', 'ep', 'ep-soft', [62, 79], 'pent-minor',
      { id: 'bounded-walk', step: 3 },
      { id: 'near-fixed-clock', interval: 2.5, jitter: 0.4 },
      [0.25, 0.45], [1, 4]),
    A('ground', 'texture', 'synth', 'pad-warm', [50, 62], 'pent-minor',
      { id: 'weighted-field', field: [1.2, 0.5, 1, 0.7, 0.9] },
      { id: 'fixed-clock', interval: 12 },
      [0.14, 0.26], [10, 14]),
    A('hint', 'chord', 'synth', 'pad-space', [45, 60], 'lydian',
      { id: 'voice-leading', maxLeap: 4 },
      { id: 'renewal-poisson', mean: 16 },
      [0.12, 0.22], [12, 18], ['ground']),
  ],
  Ht([0.15, 0.4], [0, 0.35], [0.25, 0.65], [0.7, 1], [0, 0.35], [0.3, 1], [0.15, 0.55]),
  [{ id: 'dn', feature: 'density', weight: 1, target: { min: 0.15, max: 0.4 } }],
  [{ id: 'grain-veil', kind: 'grain', baseOffset: 12, volume: 0.28 }],
);

// ----------------------------------------------------------------- 磁带河口 Tape Estuary —— 漂移旋律 + 幽暗持续 + 磁带颗粒
const tapeEstuary = base(
  'tape-estuary', '磁带河口 Tape Estuary', '磁带抖动般的漂移旋律，漂浮在缓慢幽暗的持续音上，中等静默。',
  [56, 72], 54, ['aeolian', 'pent-minor'],
  [
    A('warble', 'melody', 'synth', 'lead-dream', [62, 78], 'aeolian',
      { id: 'irrational-rotation', rotation: 0.381966 },
      { id: 'near-fixed-clock', interval: 2.75, jitter: 0.5 },
      [0.28, 0.42], [1.5, 4]),
    A('hum', 'texture', 'synth', 'pad-dark', [46, 58], 'aeolian',
      { id: 'voice-leading', maxLeap: 3 },
      { id: 'phase-drift', interval: 8, jitter: 1.2, driftPeriod: 128 },
      [0.14, 0.24], [8, 12]),
    A('tape', 'bass', 'bass', 'bass-ghost', [33, 42], 'pent-minor',
      { id: 'weighted-field', field: [2.0, 0.3, 0.6, 0.4, 0.8] },
      { id: 'renewal-poisson', mean: 9 },
      [0.16, 0.3], [5, 9]),
  ],
  Ht([0.08, 0.3], [0, 0.35], [0.2, 0.55], [0.6, 1], [0, 0.3], [0.3, 1], [0.35, 0.8]),
  [{ id: 'ts', feature: 'silenceRatio', weight: 1.1, target: { min: 0.35, max: 0.8 } }],
  [{ id: 'tape-hiss', kind: 'noise', baseOffset: -24, volume: 0.14 }],
);

// ----------------------------------------------------------------- 频谱天气 Spectral Weather —— 微光频谱簇 + 不协和琶音 + 深潜
const spectralWeather = base(
  'spectral-weather', '频谱天气 Spectral Weather', '微光的频谱簇与不协和琶音，明亮、密度高且缓慢呼吸。',
  [74, 92], 57, ['lydian', 'pent-major'],
  [
    A('clusters', 'texture', 'synth', 'pad-shimmer', [58, 74], 'lydian',
      { id: 'bounded-walk', step: 4 },
      { id: 'fixed-clock', interval: 10 },
      [0.14, 0.24], [8, 12]),
    A('spume', 'melody', 'synth', 'lead-glass', [70, 86], 'lydian',
      { id: 'voice-leading', maxLeap: 6 },
      { id: 'phase-drift', interval: 1.6, jitter: 0.3, driftPeriod: 72 },
      [0.3, 0.5], [0.4, 1.2]),
    A('undercurrent', 'bass', 'bass', 'bass-sub', [30, 39], 'pent-major',
      { id: 'irrational-rotation', rotation: 0.341 },
      { id: 'renewal-poisson', mean: 5 },
      [0.28, 0.44], [2, 5]),
  ],
  Ht([0.22, 0.5], [0, 0.45], [0.35, 0.75], [0.55, 1], [0, 0.35], [0.3, 1], [0.1, 0.5]),
  [{ id: 'sw', feature: 'density', weight: 1, target: { min: 0.22, max: 0.5 } }],
  [{ id: 'spectral-sheen', kind: 'shimmer', baseOffset: 12, volume: 0.24 }],
);

// ----------------------------------------------------------------- 潮汐阶地 Tidal Terrace —— 日本五声 + 复合律动琶音
const tidalTerrace = base(
  'tidal-terrace', '潮汐阶地 Tidal Terrace', '日本五声/五声小调上的阶地式复合律动，polyrhythm 琶音与深潜根音。',
  [66, 84], 50, ['hirajoshi', 'pent-minor'],
  [
    A('tide', 'chord', 'piano', 'piano-soft', [55, 70], 'hirajoshi',
      { id: 'bounded-walk', step: 3 },
      { id: 'renewal-poisson', mean: 4 },
      [0.2, 0.34], [2.5, 5]),
    A('current', 'bass', 'bass', 'bass-deep', [33, 44], 'pent-minor',
      { id: 'voice-leading', maxLeap: 2 },
      { id: 'euclidean', cycle: 11, pulses: 4 },
      [0.24, 0.4], [3, 6]),
    A('drift', 'texture', 'synth', 'pad-warm', [48, 60], 'pent-minor',
      { id: 'weighted-field', field: [1.1, 0.4, 0.9, 0.5, 0.7] },
      { id: 'near-fixed-clock', interval: 7, jitter: 0.8 },
      [0.13, 0.22], [7, 11]),
  ],
  Ht([0.12, 0.38], [0, 0.34], [0.2, 0.6], [0.65, 1], [0, 0.32], [0.3, 1], [0.2, 0.6]),
  [{ id: 'tt', feature: 'density', weight: 1, target: { min: 0.12, max: 0.38 } }],
  [{ id: 'terrace-drone', kind: 'drone', baseOffset: -12, volume: 0.35 }],
);

export const PRESETS: StylePreset[] = [sparseFog, phaseGarden, stillRoom, pentatonicWeather, tapeEstuary, spectralWeather, tidalTerrace];

export function getPreset(id: string): StylePreset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`未知的 Ambient 预设：${id}`);
  return p;
}

export function presetIds(): string[] {
  return PRESETS.map((p) => p.id);
}