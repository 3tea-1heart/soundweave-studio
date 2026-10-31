/**
 * MIDI Learn：CC 到「音源参数 / 轨道效果」的映射，存放于 localStorage。
 * 映射不绑定轨道，只在当前选中轨道上生效；切换轨道后沿用同一 CC。
 */

import type { Track } from './types';
import { PARAM_DEFS } from './instrument-defaults';

export type MidiLearnKind = 'param' | 'fx';

export interface MidiLearnTarget {
  kind: MidiLearnKind;
  key: string;
}

export interface MidiMapping extends MidiLearnTarget {
  /** 0–127 */
  cc: number;
  min: number;
  max: number;
}

export interface MidiRange {
  min: number;
  max: number;
  label: string;
}

const KEY = 'soundweave.midi-map.v1';
const MAX = 64;
const KINDS: MidiLearnKind[] = ['param', 'fx'];

/** 轨道效果字段的取值范围（与检查器滑杆保持一致） */
export const FX_RANGES: Record<string, MidiRange> = {
  volume: { min: 0, max: 1, label: '音量' },
  pan: { min: -1, max: 1, label: '声像' },
  sendReverb: { min: 0, max: 1, label: '混响发送' },
  sendDelay: { min: 0, max: 1, label: '延迟发送' },
  tone: { min: 0.1, max: 1, label: '音色低通' },
  drive: { min: 0, max: 1, label: '过载' },
  chorus: { min: 0, max: 1, label: '合唱' },
};

/** 当前音源上该目标是否可用；不可用（如把钢琴的参数映射到合成器）返回 null */
export function targetRange(track: Track, target: MidiLearnTarget): MidiRange | null {
  if (target.kind === 'fx') return FX_RANGES[target.key] || null;
  const def = (PARAM_DEFS[track.instrument.type] || []).find((d) => d.key === target.key);
  return def ? { min: def.min, max: def.max, label: def.label } : null;
}

export function targetLabel(track: Track, target: MidiLearnTarget): string {
  const range = targetRange(track, target);
  if (range) return range.label;
  if (target.kind === 'fx') return FX_RANGES[target.key]?.label || target.key;
  return target.key;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 校验来自 localStorage 或外部写入的一条映射 */
export function sanitizeMapping(raw: unknown): MidiMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cc !== 'number' || !Number.isFinite(r.cc)) return null;
  const cc = Math.round(r.cc);
  if (cc < 0 || cc > 127) return null;
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind as MidiLearnKind)) return null;
  if (typeof r.key !== 'string' || !r.key.trim() || r.key.length > 40) return null;
  if (typeof r.min !== 'number' || typeof r.max !== 'number') return null;
  if (!Number.isFinite(r.min) || !Number.isFinite(r.max) || !(r.max > r.min)) return null;
  return { cc, kind: r.kind as MidiLearnKind, key: r.key.trim(), min: r.min, max: r.max };
}

export function loadMidiMappings(): MidiMapping[] {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<number>();
    const list: MidiMapping[] = [];
    for (const item of parsed) {
      const m = sanitizeMapping(item);
      if (!m || seen.has(m.cc)) continue;
      seen.add(m.cc);
      list.push(m);
      if (list.length >= MAX) break;
    }
    return list;
  } catch {
    return [];
  }
}

export function saveMidiMappings(list: MidiMapping[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* localStorage 不可用时映射只在本次会话内生效 */
  }
}

/** 同一 CC 或同一目标只保留最新一条 */
export function upsertMapping(list: MidiMapping[], mapping: MidiMapping): MidiMapping[] {
  const rest = list.filter((m) => m.cc !== mapping.cc && !(m.kind === mapping.kind && m.key === mapping.key));
  rest.push(mapping);
  return rest.slice(-MAX);
}

export function removeMapping(list: MidiMapping[], cc: number): MidiMapping[] {
  return list.filter((m) => m.cc !== cc);
}

export function mappingFor(list: MidiMapping[], cc: number): MidiMapping | undefined {
  return list.find((m) => m.cc === cc);
}

/** CC 原始值 0–127 → 目标参数值 */
export function applyMidiRaw(mapping: MidiMapping, raw: number): number {
  const v = clamp(Number.isFinite(raw) ? raw : 0, 0, 127) / 127;
  return mapping.min + (mapping.max - mapping.min) * v;
}

/** 14-bit 弯音值（0–16383）→ -1..1 */
export function bendValue(raw: number): number {
  return clamp((raw - 8192) / 8192, -1, 1);
}
