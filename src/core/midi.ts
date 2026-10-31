import type { Project } from './types';
import { beatsPerBarOf } from './tempo';

export interface MidiNoteData {
  pitch: number;
  start: number;
  length: number;
  velocity: number;
}

export interface MidiTrackData {
  name: string;
  channel: number;
  program: number;
  notes: MidiNoteData[];
}

export interface ParsedMidi {
  format: number;
  ppq: number;
  tempo: number;
  tracks: MidiTrackData[];
}

const PPQ = 480;

function varLen(v: number): number[] {
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function strBytes(s: string, maxLen = 40): number[] {
  const clean = Array.from(s).filter((ch) => ch.charCodeAt(0) < 128).join('').slice(0, maxLen) || 'track';
  return Array.from(clean).map((ch) => ch.charCodeAt(0));
}

function asciiName(count: number): number[] {
  if (count < 10) return [48 + count];
  return Array.from(String(count)).map((c) => c.charCodeAt(0));
}

interface RawEvent {
  tick: number;
  bytes: number[];
}

/** 写标准 MIDI 文件（format 1），拍号与轨内音符来自工程 */
export function writeMidi(project: Project): ArrayBuffer {
  const spb = 60 / project.tempo;
  const trackChunks: number[][] = [];

  // tempo / time signature
  const meta: RawEvent[] = [];
  const usPerBeat = Math.round(60000 / project.tempo);
  meta.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff] });
  const bpb = beatsPerBarOf(project);
  const denomPow = Math.round(Math.log2(project.timeSig[1]));
  meta.push({ tick: 0, bytes: [0xff, 0x58, 0x04, project.timeSig[0], denomPow, 24, 8] });
  meta.push({ tick: 0, bytes: [0xff, 0x03, ...varLen(project.name.length ? strBytes(project.name).length : 0), ...strBytes(project.name || 'SoundWeave')] });
  meta.push({ tick: 0, bytes: [0xff, 0x2f, 0x00] });
  trackChunks.push(buildTrack(meta));

  project.tracks.forEach((track, ti) => {
    const channel = track.instrument.type === 'drum' ? 9 : Math.min(15, ti > 8 ? ti + 1 : ti);
    const ev: RawEvent[] = [];
    const nameBytes = strBytes(track.name);
    ev.push({ tick: 0, bytes: [0xff, 0x03, ...varLen(nameBytes.length), ...nameBytes] });
    const prog = guessProgram(track.instrument.type);
    ev.push({ tick: 0, bytes: [0xc0 | channel, prog] });
    const clipNotes: Array<{ tick: number; on: boolean; pitch: number; vel: number }> = [];
    for (const clip of project.clips) {
      if (clip.trackId !== track.id) continue;
      const clipEnd = clip.start + clip.length;
      for (const note of clip.notes) {
        const absStart = clip.start + note.start - clip.offset;
        const absEnd = absStart + note.length;
        const s = Math.max(absStart, clip.start);
        const e = Math.min(absEnd, clipEnd);
        if (e <= s) continue;
        const onTick = Math.round(s * PPQ);
        const offTick = Math.round(e * PPQ);
        clipNotes.push({ tick: onTick, on: true, pitch: note.pitch + clip.transpose, vel: Math.round(note.velocity * 127) });
        clipNotes.push({ tick: offTick, on: false, pitch: note.pitch + clip.transpose, vel: 0 });
      }
    }
    clipNotes.sort((a, b) => a.tick - b.tick || (a.on ? 1 : 0) - (b.on ? 1 : 0));
    for (const note of clipNotes) {
      if (note.on) {
        ev.push({ tick: note.tick, bytes: [0x90 | channel, Math.max(0, Math.min(127, note.pitch)), Math.max(1, note.vel)] });
      } else {
        ev.push({ tick: note.tick, bytes: [0x80 | channel, Math.max(0, Math.min(127, note.pitch)), 64] });
      }
    }
    ev.push({ tick: Math.max(1, Math.round(spb * 0)), bytes: [0xff, 0x2f, 0x00] });
    trackChunks.push(buildTrack(ev));
  });

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, trackChunks.length, (PPQ >> 8) & 0xff, PPQ & 0xff,
  ];
  const allBytes: number[] = [...header];
  for (const chunk of trackChunks) allBytes.push(...chunk);
  return new Uint8Array(allBytes).buffer;
}

function buildTrack(events: RawEvent[]): number[] {
  let last = 0;
  const body: number[] = [];
  for (const e of events) {
    const delta = Math.max(0, e.tick - last);
    last = e.tick;
    body.push(...varLen(delta), ...e.bytes);
  }
  const len = body.length;
  return [
    0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...body,
  ];
}

export function guessProgram(type: string): number {
  switch (type) {
    case 'piano': return 0;
    case 'ep': return 4;
    case 'guitar': return 25;
    case 'bass': return 33;
    case 'synth': return 81;
    case 'drum': return 0;
    default: return 81;
  }
}

export function guessTypeFromProgram(program: number, channel: number): 'piano' | 'ep' | 'guitar' | 'bass' | 'synth' | 'drum' {
  if (channel === 9) return 'drum';
  if (program <= 3) return 'piano';
  if (program <= 7) return 'ep';
  if (program >= 24 && program <= 31) return 'guitar';
  if (program >= 32 && program <= 39) return 'bass';
  return 'synth';
}

/** 解析标准 MIDI（format 0/1），时间单位换算为拍 */
export function parseMidi(arrayBuffer: ArrayBuffer): ParsedMidi {
  const view = new DataView(arrayBuffer);
  const readStr = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (readStr(0) !== 'MThd') throw new Error('不是有效的 MIDI 文件');
  const headerLen = view.getUint32(4, false);
  const format = view.getUint16(8, false);
  const ntrks = view.getUint16(10, false);
  const division = view.getUint16(12, false);
  if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间格式的 MIDI');
  const ppq = division || 480;
  let pos = 8 + headerLen;
  let tempo = 120;
  const tracks: MidiTrackData[] = [];

  for (let t = 0; t < ntrks && pos + 8 <= view.byteLength; t++) {
    if (readStr(pos) !== 'MTrk') {
      const len = view.getUint32(pos + 4, false);
      pos += 8 + len;
      continue;
    }
    const len = view.getUint32(pos + 4, false);
    const end = Math.min(view.byteLength, pos + 8 + len);
    let p = pos + 8;
    let tick = 0;
    let running = 0;
    let name = `MIDI 轨道 ${t + 1}`;
    let program = 0;
    let channel = 0;
    const open: Array<{ pitch: number; start: number; velocity: number; channel: number }> = [];
    const notes: MidiNoteData[] = [];
    const noteOnAt = new Map<string, Array<{ start: number; velocity: number }>>();

    while (p < end) {
      // delta
      let delta = 0;
      let b = 0;
      do {
        b = view.getUint8(p++);
        delta = (delta << 7) | (b & 0x7f);
      } while (b & 0x80);
      tick += delta;
      let status = view.getUint8(p);
      if (status & 0x80) {
        p++;
        running = status;
      } else {
        status = running;
      }
      if (!status) break;
      if (status === 0xff) {
        const metaType = view.getUint8(p++);
        let mlen = 0;
        let mb = 0;
        do {
          mb = view.getUint8(p++);
          mlen = (mlen << 7) | (mb & 0x7f);
        } while (mb & 0x80);
        if (metaType === 0x51 && mlen >= 3) {
          const us = (view.getUint8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2);
          if (t === 0 && us > 0) tempo = 60000000 / us;
        } else if (metaType === 0x03) {
          let s = '';
          for (let i = 0; i < mlen; i++) s += String.fromCharCode(view.getUint8(p + i));
          if (s) name = s;
        }
        p += mlen;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        let mlen = 0;
        let mb = 0;
        do {
          mb = view.getUint8(p++);
          mlen = (mlen << 7) | (mb & 0x7f);
        } while (mb & 0x80);
        p += mlen;
        continue;
      }
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (ch === 9) channel = 9;
      if (type === 0xc0) {
        program = view.getUint8(p++);
        if (ch !== 9) channel = ch;
        continue;
      }
      if (type === 0xd0) {
        p += 1;
        continue;
      }
      const d1 = view.getUint8(p++);
      const d2 = type === 0x80 || type === 0x90 || type === 0xa0 || type === 0xb0 || type === 0xe0 ? view.getUint8(p++) : 0;
      if (type === 0x90 && d2 > 0) {
        const key = String(d1);
        const list = noteOnAt.get(key) || [];
        list.push({ start: tick, velocity: d2 / 127 });
        noteOnAt.set(key, list);
        open.push({ pitch: d1, start: tick, velocity: d2 / 127, channel: ch });
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        const list = noteOnAt.get(String(d1));
        if (list && list.length) {
          const on = list.shift();
          if (on) notes.push({ pitch: d1, start: on.start / ppq, length: Math.max(0.02, (tick - on.start) / ppq), velocity: on.velocity });
        }
      }
    }
    if (notes.length) tracks.push({ name, channel, program, notes });
    pos = end;
  }
  return { format, ppq, tempo, tracks };
}
