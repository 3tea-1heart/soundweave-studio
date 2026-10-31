import type { Project, Clip, Note } from './types';

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

export function secondsToBeats(sec: number, bpm: number): number {
  return (sec * bpm) / 60;
}

export function barOf(beat: number, beatsPerBar: number): number {
  return Math.floor(beat / beatsPerBar);
}

export function quantize(beat: number, grid: number): number {
  if (grid <= 0) return beat;
  return Math.round(beat / grid) * grid;
}

export function floorToGrid(beat: number, grid: number): number {
  if (grid <= 0) return beat;
  return Math.floor(beat / grid) * grid;
}

export function beatsPerBarOf(p: Project): number {
  return p.timeSig[0] * 4 / p.timeSig[1];
}

/** 片段内音符的绝对开始拍 / 结束拍（含移调与偏移裁剪） */
export function absoluteNoteRange(clip: Clip, note: Note): { start: number; end: number } {
  const local = note.start - clip.offset;
  return {
    start: clip.start + local,
    end: clip.start + local + note.length,
  };
}

/** 片段是否在给定拍区间内发声 */
export function clipOverlaps(clip: Clip, from: number, to: number): boolean {
  return clip.start < to && clip.start + clip.length > from;
}

/**
 * 收集 [from, to) 区间内需要排程的音符（自动裁剪到循环/片段边界）。
 * 返回绝对拍时间，由调度器转换为音频秒。
 */
export function collectNotes(project: Project, fromBeat: number, toBeat: number): Array<{
  trackId: string;
  note: Note;
  startBeat: number;
  endBeat: number;
  clipId: string;
  absolutePitch: number;
  velocity: number;
}> {
  const out: Array<any> = [];
  for (const clip of project.clips) {
    if (!clipOverlaps(clip, fromBeat, toBeat)) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track) continue;
    const clipEnd = clip.start + clip.length;
    for (const note of clip.notes) {
      const abs = absoluteNoteRange(clip, note);
      if (abs.end <= clip.start || abs.start >= clipEnd) continue;
      if (abs.end <= fromBeat || abs.start >= toBeat) continue;
      // 裁到片段边界
      const s = Math.max(abs.start, clip.start, fromBeat);
      const e = Math.min(abs.end, clipEnd);
      if (e <= s) continue;
      out.push({
        trackId: clip.trackId,
        note,
        startBeat: s,
        endBeat: e,
        clipId: clip.id,
        absolutePitch: note.pitch + clip.transpose,
        velocity: note.velocity,
      });
    }
  }
  return out;
}

/** 工程实际内容结束拍（不含 loop） */
export function contentEndBeat(project: Project): number {
  let end = 0;
  for (const c of project.clips) end = Math.max(end, c.start + c.length);
  return end;
}

export function formatBeat(beat: number, beatsPerBar: number): string {
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = Math.floor(beat % beatsPerBar) + 1;
  return `${bar}.${beatInBar}`;
}
