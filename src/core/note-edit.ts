import type { Note } from './types';

/** 音符编辑的纯函数集合：钢琴卷帘与回归测试共用，不依赖 DOM */

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function cloneNotes(notes: Note[]): Note[] {
  return notes.map((n) => ({ ...n }));
}

/**
 * 矩形框选：返回起点或尾段与矩形相交的音符。
 * 坐标一律使用音乐单位（拍 / MIDI 音高），不涉及像素。
 */
export function notesInRect(
  notes: Note[],
  beatA: number,
  beatB: number,
  pitchA: number,
  pitchB: number,
): Note[] {
  const b0 = Math.min(beatA, beatB);
  const b1 = Math.max(beatA, beatB);
  const p0 = Math.min(pitchA, pitchB);
  const p1 = Math.max(pitchA, pitchB);
  return notes.filter(
    (n) => n.pitch >= p0 && n.pitch <= p1 && n.start < b1 && n.start + n.length > b0,
  );
}

/** 粘贴：以剪贴板最早音符为基准对齐到 destBeat，并为每个音符生成新 ID */
export function pasteNotes(
  source: Note[],
  destBeat: number,
  clipLength: number,
  idFactory: () => string,
): Note[] {
  if (!source.length) return [];
  const minStart = Math.min(...source.map((n) => n.start));
  const base = Math.max(0, destBeat);
  const maxStart = Math.max(0, clipLength - 0.0625);
  return source.map((n) => ({
    ...n,
    id: idFactory(),
    start: clamp(base + (n.start - minStart), 0, maxStart),
  }));
}

/** 批量设置力度，返回实际修改的音符数 */
export function setNotesVelocity(notes: Note[], velocity: number): number {
  const v = clamp(velocity, 0.05, 1);
  for (const n of notes) n.velocity = v;
  return notes.length;
}

/** 按 ID 删除，返回删除后的数组（与原数组共享未删除对象） */
export function removeNotesById(notes: Note[], ids: Set<string>): Note[] {
  return notes.filter((n) => !ids.has(n.id));
}

/** 键盘微调：按拍/音高平移一组音符，起点不越过片段开头 */
export function nudgeNotes(notes: Note[], dBeat: number, dPitch: number): void {
  for (const n of notes) {
    n.start = Math.max(0, n.start + dBeat);
    n.pitch = clamp(n.pitch + dPitch, 24, 108);
  }
}

/** 同一时间可能存在的重复音符判定（鼓步进 / 吸附后重叠提示用） */
export function hasNoteAt(notes: Note[], pitch: number, beat: number, tolerance = 0.06): boolean {
  return notes.some((n) => n.pitch === pitch && Math.abs(n.start - beat) <= tolerance);
}
