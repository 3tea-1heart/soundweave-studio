import type { Project, Track, Articulation } from './types';
import { controlAt, automationSignature } from './automation';

/**
 * 播放/导出共享的会话计划。
 * 实时调度与离线渲染都从这里取音符、节拍器与控制事件，
 * 避免两条路径在 loop、solo、自动化上出现分歧。
 */

export const MAX_USER_TRACKS = 15;
export const PREVIEW_TRACK_INDEX = 15;
export const AUTOMATION_STEP_BEATS = 0.0625;

export interface PlannedNote {
  trackIndex: number;
  clipId: string;
  noteId: string;
  pitch: number;
  velocity: number;
  startBeat: number;
  endBeat: number;
  articulation: Articulation;
}

/**
 * 只收集“起点落在 [fromBeat, toBeat)”的音符。
 * 已在窗口开始前起音的长音不会再次触发；跨过循环边界的音符被截断到边界。
 */
export function plannedNoteStarts(
  project: Project,
  fromBeat: number,
  toBeat: number,
  passEndBeat = Infinity,
): PlannedNote[] {
  const out: PlannedNote[] = [];
  const trackIndex = new Map<string, number>();
  project.tracks.slice(0, MAX_USER_TRACKS).forEach((t, i) => trackIndex.set(t.id, i));
  for (const clip of project.clips) {
    // 音频片段只走 audio 事件；即使历史上残留了音符也不发声，避免音频轨混出合成器声部
    if (clip.audio) continue;
    const ti = trackIndex.get(clip.trackId);
    if (ti === undefined) continue;
    const clipEnd = clip.start + clip.length;
    for (const note of clip.notes) {
      const absStart = clip.start + note.start - clip.offset;
      const absEnd = absStart + note.length;
      if (absEnd <= clip.start || absStart >= clipEnd) continue;
      // 起点被片段裁剪时，以片段起点作为可见起点
      const start = Math.max(absStart, clip.start);
      if (start < fromBeat || start >= toBeat) continue;
      const end = Math.min(absEnd, clipEnd, passEndBeat);
      if (end <= start) continue;
      out.push({
        trackIndex: ti,
        clipId: clip.id,
        noteId: note.id,
        pitch: note.pitch + clip.transpose,
        velocity: note.velocity,
        startBeat: start,
        endBeat: end,
        articulation: note.articulation,
      });
    }
  }
  return out;
}

export interface PlannedAudio {
  trackIndex: number;
  clipId: string;
  assetId: string;
  startBeat: number;
  endBeat: number;
  offsetSec: number;
  gain: number;
}

/**
 * 与音符相同的窗口规则：只收集起点落在 [fromBeat, toBeat) 的音频片段。
 * 片段终点截断在循环边界或本轮结束（passEndBeat）。
 */
export function plannedAudioStarts(
  project: Project,
  fromBeat: number,
  toBeat: number,
  passEndBeat = Infinity,
): PlannedAudio[] {
  const out: PlannedAudio[] = [];
  const trackIndex = new Map<string, number>();
  project.tracks.slice(0, MAX_USER_TRACKS).forEach((t, i) => trackIndex.set(t.id, i));
  for (const clip of project.clips) {
    const audio = clip.audio;
    if (!audio) continue;
    const ti = trackIndex.get(clip.trackId);
    if (ti === undefined) continue;
    const start = clip.start;
    if (start < fromBeat || start >= toBeat) continue;
    const end = Math.min(clip.start + clip.length, passEndBeat);
    if (end <= start) continue;
    out.push({
      trackIndex: ti,
      clipId: clip.id,
      assetId: audio.assetId,
      startBeat: start,
      endBeat: end,
      offsetSec: audio.offsetSec,
      gain: audio.gain,
    });
  }
  return out;
}

export interface ClickSpec {
  /** 点击粒度（以四分音符为 1 拍） */
  gridBeats: number;
  /** 每小节点击数 */
  stepsPerBar: number;
}

/**
 * 节拍器点击约定：
 * - 简单拍（4/4、3/4 等）：每拍一次；
 * - 复合拍（6/8、9/8、12/8）：每三个八分音符（附点四分）一次；
 * - 其它 8 分拍号（如 7/8）：每八分音符一次。
 * 小节第一拍加重音。
 */
export function clickSpec(timeSig: [number, number]): ClickSpec {
  const [num, den] = timeSig;
  const barBeats = (num * 4) / den;
  const compound = den >= 8 && num % 3 === 0;
  const gridBeats = ((compound ? 3 : 1) * 4) / den;
  const stepsPerBar = Math.max(1, Math.round(barBeats / gridBeats));
  return { gridBeats, stepsPerBar };
}

export function clickStepAt(beat: number, gridBeats: number): number {
  return Math.ceil(beat / gridBeats - 1e-9);
}

export interface PlannedClick {
  beat: number;
  accent: boolean;
}

/** 从 startStep 开始，列出拍号网格上所有 < untilBeat 的点击 */
export function clicksFromStep(timeSig: [number, number], startStep: number, untilBeat: number): PlannedClick[] {
  const spec = clickSpec(timeSig);
  const out: PlannedClick[] = [];
  let step = Math.max(0, Math.floor(startStep));
  for (let guard = 0; guard < 8192; guard++) {
    const beat = step * spec.gridBeats;
    if (beat >= untilBeat - 1e-9) break;
    out.push({ beat, accent: step % spec.stepsPerBar === 0 });
    step++;
  }
  return out;
}

export interface ControlEvent {
  trackIndex: number;
  beat: number;
  message: Record<string, unknown>;
}

/**
 * 在 [fromBeat, toBeat) 内按固定网格采样自动化控制值。
 * lastKeys 用于跨窗口去重；离线导出不传时逐点输出。
 */
export function automationControls(
  project: Project,
  fromBeat: number,
  toBeat: number,
  lastKeys?: Map<number, string>,
  onlyTrack?: string,
): ControlEvent[] {
  const out: ControlEvent[] = [];
  const step = AUTOMATION_STEP_BEATS;
  if (!(fromBeat < toBeat)) return out;
  project.tracks.slice(0, MAX_USER_TRACKS).forEach((track, index) => {
    if (onlyTrack && track.id !== onlyTrack) return;
    if (!track.automation.some((l) => l.points.length)) return;
    const beats: number[] = [fromBeat];
    const firstGrid = Math.ceil((fromBeat + 1e-9) / step) * step;
    for (let b = firstGrid; b < toBeat - 1e-9; b += step) beats.push(b);
    for (const beat of beats) {
      const message = controlAt(track, beat);
      const key = JSON.stringify(message);
      if (lastKeys) {
        if (lastKeys.get(index) === key) continue;
        lastKeys.set(index, key);
      }
      out.push({ trackIndex: index, beat, message });
    }
  });
  return out;
}

export function trackMessage(track: Track, index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'track',
    track: index,
    instrumentType: track.instrument.type,
    params: { ...track.instrument.params },
    sampleBank: track.instrument.sampleBank || null,
    volume: track.volume,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    sendReverb: track.sendReverb,
    sendDelay: track.sendDelay,
    tone: track.tone,
    drive: track.drive,
    chorus: track.chorus,
    ...overrides,
  };
}

export interface SessionPlanOptions {
  endBeat?: number;
  onlyTrack?: string;
}

export interface SessionPlan {
  endBeat: number;
  trackMessages: Array<{ index: number; message: Record<string, unknown> }>;
  notes: PlannedNote[];
  audio: PlannedAudio[];
  controls: ControlEvent[];
}

/**
 * 构建离线渲染计划：
 * - 完整混音沿用工程里的 mute/solo；
 * - 分轨（onlyTrack）忽略其它轨独奏，并把其它轨静音；
 * - 控制事件与实时播放使用同一自动化网格。
 */
export function buildSessionPlan(project: Project, opts: SessionPlanOptions = {}): SessionPlan {
  let endBeat = 0;
  for (const c of project.clips) endBeat = Math.max(endBeat, c.start + c.length);
  endBeat = Math.max(4, opts.endBeat ?? endBeat);
  const trackMessages = project.tracks.slice(0, MAX_USER_TRACKS).map((track, index) => {
    if (opts.onlyTrack) {
      return { index, message: trackMessage(track, index, { mute: track.id !== opts.onlyTrack, solo: false }) };
    }
    return { index, message: trackMessage(track, index) };
  });
  const notes = opts.onlyTrack
    ? plannedNoteStarts(project, 0, endBeat).filter((n) => project.tracks[n.trackIndex]?.id === opts.onlyTrack)
    : plannedNoteStarts(project, 0, endBeat);
  const audio = opts.onlyTrack
    ? plannedAudioStarts(project, 0, endBeat).filter((a) => project.tracks[a.trackIndex]?.id === opts.onlyTrack)
    : plannedAudioStarts(project, 0, endBeat);
  const controls = automationControls(project, 0, endBeat, new Map(), opts.onlyTrack);
  return { endBeat, trackMessages, notes, audio, controls };
}

/** 轨道自动化指纹（供调度器检测 lane 增删与编辑） */
export function trackAutomationSignature(track: Track): string {
  return automationSignature(track);
}
