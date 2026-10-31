import type { InstrumentType } from './types';

/** 与 AudioWorklet 内 TYPE_DEFAULTS 保持一致的界面侧默认参数 */
export const DEFAULT_PARAMS: Record<InstrumentType, Record<string, number>> = {
  ep: {
    index: 2.0, tine: 0.45, decay: 1.4, sustain: 0.22, release: 0.35,
    tone: 0.82, drive: 0.05, chorus: 0.0, attack: 0.003, octave: 0,
  },
  piano: {
    brightness: 0.55, decay: 1.6, sustain: 0.28, release: 0.45,
    tone: 0.86, drive: 0.02, chorus: 0.0, attack: 0.004, octave: 0,
  },
  guitar: {
    damping: 0.42, bright: 0.52, drive: 0.03, chorus: 0.0, octave: 0,
  },
  synth: {
    wave: 0, cutoff: 900, resonance: 0.35, drive: 0.12, detune: 7, sub: 0.2,
    attack: 0.02, decay: 0.4, sustain: 0.35, release: 0.35, filterEnv: 0.55,
    lfoRate: 3.2, lfoDepth: 0.0, tremolo: 0.0, octave: 0, tone: 0.95, chorus: 0.0,
    pulseWidth: 0.5,
  },
  bass: {
    wave: 0, cutoff: 420, resonance: 0.3, drive: 0.18, detune: 3, sub: 0.55,
    attack: 0.006, decay: 0.28, sustain: 0.3, release: 0.2, filterEnv: 0.7,
    lfoRate: 1.2, lfoDepth: 0.0, tremolo: 0.0, octave: -12, tone: 0.9, chorus: 0.0,
    pulseWidth: 0.5,
  },
  drum: {
    punch: 0.6, decay: 0.45, tone: 0.6, toneShift: 0.5, drive: 0.1, chorus: 0.0,
  },
};

export function mergeParams(type: InstrumentType, partial?: Record<string, number>): Record<string, number> {
  return { ...DEFAULT_PARAMS[type], ...(partial || {}) };
}

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const octave: ParamDef = { key: 'octave', label: '八度', min: -12, max: 12, step: 12 };
const tone: ParamDef = { key: 'tone', label: '音色低通', min: 0, max: 1, step: 0.01 };
const drive: ParamDef = { key: 'drive', label: '过载', min: 0, max: 1, step: 0.01 };
const chorus: ParamDef = { key: 'chorus', label: '合唱', min: 0, max: 1, step: 0.01 };
const sustain: ParamDef = { key: 'sustain', label: '延音', min: 0.02, max: 1, step: 0.01 };
const release: ParamDef = { key: 'release', label: '释音', min: 0.03, max: 2.5, step: 0.01, unit: 's' };

export const PARAM_DEFS: Record<InstrumentType, ParamDef[]> = {
  ep: [
    { key: 'index', label: 'FM 深度', min: 0.3, max: 5, step: 0.01 },
    { key: 'tine', label: '金属齿音', min: 0, max: 1, step: 0.01 },
    { key: 'decay', label: '衰减', min: 0.15, max: 4, step: 0.01, unit: 's' },
    sustain,
    release,
    { key: 'attack', label: '起音', min: 0.001, max: 0.2, step: 0.001, unit: 's' },
    tone, drive, chorus, octave,
  ],
  piano: [
    { key: 'brightness', label: '明亮度', min: 0.1, max: 1, step: 0.01 },
    { key: 'decay', label: '衰减', min: 0.2, max: 4, step: 0.01, unit: 's' },
    sustain, release,
    { key: 'attack', label: '起音', min: 0.001, max: 0.2, step: 0.001, unit: 's' },
    tone, drive, chorus, octave,
  ],
  guitar: [
    { key: 'damping', label: '阻尼', min: 0.05, max: 1, step: 0.01 },
    { key: 'bright', label: '亮度', min: 0.05, max: 1, step: 0.01 },
    drive, chorus, octave,
  ],
  synth: [
    { key: 'wave', label: '波形 (0 锯/1 方)', min: 0, max: 1, step: 1 },
    { key: 'cutoff', label: '滤波截止', min: 100, max: 6000, step: 1, unit: 'Hz' },
    { key: 'resonance', label: '共振', min: 0, max: 1, step: 0.01 },
    { key: 'filterEnv', label: '滤波包络', min: 0, max: 1, step: 0.01 },
    { key: 'detune', label: '失谐', min: 0, max: 50, step: 0.5, unit: 'ct' },
    { key: 'sub', label: '子振荡器', min: 0, max: 1, step: 0.01 },
    { key: 'attack', label: '起音', min: 0.001, max: 2, step: 0.001, unit: 's' },
    { key: 'decay', label: '衰减', min: 0.02, max: 4, step: 0.01, unit: 's' },
    sustain, release,
    { key: 'lfoRate', label: 'LFO 速率', min: 0.2, max: 20, step: 0.1, unit: 'Hz' },
    { key: 'lfoDepth', label: '颤音深度', min: 0, max: 1, step: 0.01 },
    { key: 'tremolo', label: '音量颤动', min: 0, max: 1, step: 0.01 },
    { key: 'pulseWidth', label: '方波宽度', min: 0.1, max: 0.9, step: 0.01 },
    drive, tone, chorus, octave,
  ],
  bass: [
    { key: 'wave', label: '波形 (0 锯/1 方)', min: 0, max: 1, step: 1 },
    { key: 'cutoff', label: '滤波截止', min: 80, max: 3000, step: 1, unit: 'Hz' },
    { key: 'resonance', label: '共振', min: 0, max: 1, step: 0.01 },
    { key: 'filterEnv', label: '滤波包络', min: 0, max: 1, step: 0.01 },
    { key: 'detune', label: '失谐', min: 0, max: 50, step: 0.5, unit: 'ct' },
    { key: 'sub', label: '子振荡器', min: 0, max: 1, step: 0.01 },
    { key: 'attack', label: '起音', min: 0.001, max: 1, step: 0.001, unit: 's' },
    { key: 'decay', label: '衰减', min: 0.02, max: 3, step: 0.01, unit: 's' },
    sustain, release,
    { key: 'lfoRate', label: 'LFO 速率', min: 0.2, max: 12, step: 0.1, unit: 'Hz' },
    { key: 'lfoDepth', label: '颤音深度', min: 0, max: 1, step: 0.01 },
    { key: 'pulseWidth', label: '方波宽度', min: 0.1, max: 0.9, step: 0.01 },
    drive, tone, chorus, octave,
  ],
  drum: [
    { key: 'punch', label: '冲击', min: 0, max: 1, step: 0.01 },
    { key: 'decay', label: '衰减', min: 0.1, max: 1, step: 0.01 },
    { key: 'toneShift', label: '音高偏移', min: 0, max: 1, step: 0.01 },
    { key: 'tone', label: '音色低通', min: 0, max: 1, step: 0.01 },
    drive, chorus,
  ],
};

export const DRUM_NAMES: Record<number, string> = {
  35: '底鼓', 36: '底鼓', 38: '军鼓', 41: '低通鼓', 42: '踩镲', 44: '开镲',
  45: '通鼓', 46: '开镲', 49: '拍手', 50: '沙锤', 51: '镲片', 55: '打击乐', 56: '打击乐',
};

export const DRUM_ORDER = [36, 38, 42, 44, 49, 45, 51, 50];
