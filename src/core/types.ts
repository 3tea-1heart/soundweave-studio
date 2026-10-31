export type InstrumentType = 'ep' | 'piano' | 'guitar' | 'synth' | 'bass' | 'drum';

/** 轨道类型：合成音源轨 / 音频轨（WAV 素材） */
export type TrackKind = 'instrument' | 'audio';

export type Articulation = 'normal' | 'mute';

/** 导入的 WAV 素材（PCM 以 base64 存放，自动保存时剥离 data） */
export interface AudioAsset {
  id: string;
  name: string;
  sampleRate: number;
  /** 1 或 2 */
  channels: number;
  /** 秒 */
  duration: number;
  /** Int16 交错 PCM 的 base64；缺失表示素材未随工程载入 */
  data?: string;
  /** 时间轴波形峰值（0–1），每个 bin 约 10 ms */
  peaks?: number[];
}

export interface AutomationPoint {
  beat: number;
  value: number;
}

export interface AutomationLane {
  paramId: string;
  points: AutomationPoint[];
}

export interface InstrumentState {
  presetId: string;
  type: InstrumentType;
  params: Record<string, number>;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  /** 缺省为合成音源轨 */
  kind?: TrackKind;
  instrument: InstrumentState;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sendReverb: number;
  sendDelay: number;
  tone: number;
  drive: number;
  chorus: number;
  automation: AutomationLane[];
}

export interface Note {
  id: string;
  pitch: number;
  start: number;
  length: number;
  velocity: number;
  articulation: Articulation;
}

export interface Clip {
  id: string;
  trackId: string;
  name: string;
  start: number;
  length: number;
  offset: number;
  transpose: number;
  sourceBlockId?: string;
  notes: Note[];
  /** 音频片段引用素材；存在时 notes 应为空 */
  audio?: {
    assetId: string;
    /** 进入素材的起点（秒） */
    offsetSec: number;
    gain: number;
  };
}

export interface MasterState {
  volume: number;
}

/** Generative Ambient 生成的工程元数据（用于重载后恢复预设与 seed） */
export interface AmbientMeta {
  presetId: string;
  seed: string;
  schemaVersion: number;
  durationSec?: number;
}

export interface Project {
  version: number;
  id: string;
  name: string;
  tempo: number;
  timeSig: [number, number];
  loop: { enabled: boolean; start: number; end: number };
  tracks: Track[];
  clips: Clip[];
  /** WAV 音频素材；手动保存包含 PCM，自动保存剥离 PCM */
  audioAssets?: AudioAsset[];
  master: MasterState;
  /** Generative Ambient 生成元数据（存在时表示由 Ambient 模块生成） */
  ambient?: AmbientMeta;
  createdAt: string;
  updatedAt: string;
}

export interface PresetMacroTarget {
  param?: string;
  fx?: 'sendReverb' | 'sendDelay' | 'chorus' | 'drive' | 'tone';
  min: number;
  max: number;
}

export interface PresetMacro {
  id: string;
  name: string;
  targets: PresetMacroTarget[];
}

/** 自定义音色保存的轨道级效果快照 */
export type PresetFx = Partial<Pick<
  Track, 'volume' | 'pan' | 'sendReverb' | 'sendDelay' | 'tone' | 'drive' | 'chorus'
>>;

export interface Preset {
  id: string;
  name: string;
  category: string;
  type: InstrumentType;
  description: string;
  tags: string[];
  params: Record<string, number>;
  value?: number;
  macros: PresetMacro[];
  usage?: string;
  /** 自定义音色的轨道效果快照；内置预设不设置 */
  fx?: PresetFx;
  /** 是否为用户保存的音色 */
  custom?: boolean;
}

export interface MusicBlock {
  id: string;
  name: string;
  category: 'chords' | 'melody' | 'bass' | 'drums' | 'fill';
  bars: number;
  beatCount: number;
  key: string;
  style: string;
  tempoRange: [number, number];
  recommendedType: InstrumentType;
  tags: string[];
  notes: Note[];
  /** 是否为用户保存的编曲块 */
  custom?: boolean;
}
