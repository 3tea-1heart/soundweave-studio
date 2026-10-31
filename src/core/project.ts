import type { Project, Track, Clip, Note, TrackKind } from './types';
import { sanitizeAudioAsset } from './audio-asset';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter++;
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${counter}`;
}

export const TRACK_COLORS = ['#7aa2ff', '#ffb86b', '#7ee0b0', '#e8a0ff', '#ffd76b', '#75d6ff', '#ff8f9c', '#b8e986'];

export function createNote(pitch: number, start: number, length: number, velocity = 0.7): Note {
  return { id: uid('n'), pitch, start, length, velocity, articulation: 'normal' };
}

export function createTrack(index: number, instrument: Track['instrument'], name?: string, kind: TrackKind = 'instrument'): Track {
  return {
    id: uid('t'),
    name: name || `轨道 ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    kind,
    instrument,
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    sendReverb: 0.18,
    sendDelay: 0,
    tone: 0.9,
    drive: 0.04,
    chorus: 0,
    automation: [],
  };
}

export function createClip(trackId: string, start: number, length = 4, name = '新片段'): Clip {
  return {
    id: uid('c'),
    trackId,
    name,
    start,
    length,
    offset: 0,
    transpose: 0,
    notes: [],
  };
}

export function createAudioClip(
  trackId: string,
  start: number,
  length: number,
  assetId: string,
  name = '音频片段',
): Clip {
  return {
    id: uid('c'),
    trackId,
    name,
    start,
    length,
    offset: 0,
    transpose: 0,
    notes: [],
    audio: { assetId, offsetSec: 0, gain: 1 },
  };
}

/** 轨道是否为音频轨（缺省 kind 视为合成音源轨） */
export function isAudioTrack(track: Track): boolean {
  return track.kind === 'audio';
}

export function createEmptyProject(): Project {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: uid('p'),
    name: '未命名工程',
    tempo: 100,
    timeSig: [4, 4],
    loop: { enabled: true, start: 0, end: 16 },
    tracks: [
      createTrack(0, { presetId: 'ep-warm', type: 'ep', params: {} }, '电钢琴'),
      createTrack(1, { presetId: 'bass-sub', type: 'bass', params: {} }, '贝斯'),
      createTrack(2, { presetId: 'drum-house', type: 'drum', params: {} }, '鼓机'),
    ],
    clips: [],
    master: { volume: 0.9 },
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p));
}

export function projectDurationBeats(p: Project): number {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, c.start + c.length);
  if (p.loop.enabled) end = Math.max(end, p.loop.end);
  return Math.max(end, 4);
}

/** 序列化（导出文件） */
export function serializeProject(p: Project): string {
  return JSON.stringify({ ...p, updatedAt: new Date().toISOString() }, null, 1);
}

/** 反序列化 + 基础迁移/容错，拒绝无法使用的数据 */
export function parseProject(text: string): Project {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('工程文件格式无效');
  if (!Array.isArray(raw.tracks) || !Array.isArray(raw.clips)) throw new Error('工程缺少轨道或片段数据');
  const p = raw as Project;
  p.version = 1;
  p.master = p.master || { volume: 0.9 };
  p.loop = p.loop || { enabled: true, start: 0, end: 16 };
  p.timeSig = p.timeSig || [4, 4];
  p.tempo = Number.isFinite(p.tempo) ? p.tempo : 100;
  if (p.ambient && typeof p.ambient === 'object') {
    p.ambient = {
      presetId: String(p.ambient.presetId || ''),
      seed: String(p.ambient.seed ?? ''),
      schemaVersion: Number.isFinite(p.ambient.schemaVersion) ? p.ambient.schemaVersion : 1,
      durationSec: Number.isFinite(p.ambient.durationSec) ? p.ambient.durationSec : undefined,
    };
  } else {
    delete p.ambient;
  }
  if (Array.isArray(p.audioAssets)) {
    const seen = new Set<string>();
    const assets = [];
    for (const rawAsset of p.audioAssets) {
      const clean = sanitizeAudioAsset(rawAsset);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      assets.push(clean);
    }
    p.audioAssets = assets;
  } else {
    p.audioAssets = [];
  }
  for (const t of p.tracks) {
    t.kind = t.kind === 'audio' ? 'audio' : 'instrument';
    t.automation = t.automation || [];
    t.instrument = t.instrument || { presetId: 'synth-lead', type: 'synth', params: {} };
    t.instrument.params = t.instrument.params || {};
    for (const k of ['volume', 'pan', 'sendReverb', 'sendDelay', 'tone', 'drive', 'chorus'] as const) {
      if (!Number.isFinite(t[k])) t[k] = k === 'volume' ? 0.85 : 0;
    }
  }
  for (const c of p.clips) {
    c.offset = Number.isFinite(c.offset) ? c.offset : 0;
    c.transpose = Number.isFinite(c.transpose) ? c.transpose : 0;
    c.length = Math.max(0.25, c.length || 4);
    c.notes = Array.isArray(c.notes) ? c.notes : [];
    if (c.audio && typeof c.audio === 'object') {
      const raw = c.audio as { assetId?: unknown; offsetSec?: unknown; gain?: unknown };
      const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim().slice(0, 80) : '';
      if (assetId) {
        const offsetSec = Number(raw.offsetSec);
        const gain = Number(raw.gain);
        c.audio = {
          assetId,
          offsetSec: Number.isFinite(offsetSec) && offsetSec >= 0 ? offsetSec : 0,
          gain: Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1,
        };
        // 音频片段不承载音符，避免两条发声路径叠加
        c.notes = [];
      } else {
        delete c.audio;
      }
    } else if (c.audio) {
      delete c.audio;
    }
    for (const n of c.notes) {
      n.articulation = n.articulation === 'mute' ? 'mute' : 'normal';
      n.velocity = Math.min(1, Math.max(0.05, n.velocity ?? 0.7));
      n.length = Math.max(0.01, n.length || 0.25);
    }
  }
  return p;
}

export function findTrack(p: Project, id: string | null | undefined): Track | undefined {
  return id ? p.tracks.find((t) => t.id === id) : undefined;
}

export function findClip(p: Project, id: string | null | undefined): Clip | undefined {
  return id ? p.clips.find((c) => c.id === id) : undefined;
}

export function nextClipStart(p: Project, trackId: string): number {
  let end = 0;
  for (const c of p.clips) if (c.trackId === trackId) end = Math.max(end, c.start + c.length);
  return end;
}
