import type { Note, Articulation } from './types';
import { quantize } from './tempo';

/**
 * 回溯录制：未按下录制键时的实时演奏被滚动缓冲保存，
 * 之后可一键把缓冲里的灵感写回当前片段。
 */

export interface RetroEvent {
  pitch: number;
  velocity: number;
  articulation: Articulation;
  /** 按下时刻的绝对拍 */
  start: number;
  /** 绝对拍时长 */
  length: number;
}

export const RETRO_MAX = 64;

/** 追加一条回溯事件，超出上限时丢弃最早的（滚动缓冲） */
export function pushRetro(buf: RetroEvent[], ev: RetroEvent, max = RETRO_MAX): RetroEvent[] {
  buf.push({ ...ev, length: Math.max(0.0625, ev.length) });
  if (buf.length > max) buf.splice(0, buf.length - max);
  return buf;
}

/**
 * 把回溯缓冲转换为目标片段内的音符：
 * - 起始拍吸附到 grid（snap）；
 * - 时长按 1/16 拍取整且不低于 0.0625；
 * - 超出片段范围的音符被丢弃，时长越界的音符裁到片段结尾。
 */
export function retroToNotes(
  buf: RetroEvent[],
  clipStart: number,
  clipOffset: number,
  clipLength: number,
  snap: number,
  idGen: () => string,
): Note[] {
  const grid = snap > 0 ? snap : 0.25;
  const out: Note[] = [];
  for (const ev of buf) {
    const local = ev.start - clipStart + clipOffset;
    const start = quantize(local, grid);
    if (start < 0 || start >= clipLength) continue;
    let length = Math.max(0.0625, Math.round(ev.length * 16) / 16);
    if (start + length > clipLength) length = clipLength - start;
    if (length < 0.0625) continue;
    out.push({
      id: idGen(),
      pitch: ev.pitch,
      start,
      length,
      velocity: ev.velocity,
      articulation: ev.articulation,
    });
  }
  return out;
}