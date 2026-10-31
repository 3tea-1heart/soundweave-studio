import type { Project, Track, Clip } from './types';
import { createTrack, uid } from './project';
import { presetById } from './presets';
import { mergeParams } from './instrument-defaults';
import { blockById, cloneBlockNotes } from './blocks';

function mkTrack(index: number, name: string, presetId: string, overrides: Partial<Track> = {}): Track {
  const preset = presetById(presetId);
  if (!preset) throw new Error(`未知预设 ${presetId}`);
  const t = createTrack(index, { presetId: preset.id, type: preset.type, params: mergeParams(preset.type, preset.params) }, name);
  return Object.assign(t, overrides);
}

function addClip(p: Project, track: Track, blockId: string, start: number, transpose = 0, extra: Partial<Clip> = {}): Clip {
  const block = blockById(blockId);
  if (!block) throw new Error(`未知编曲块 ${blockId}`);
  const clip: Clip = {
    id: uid('c'),
    trackId: track.id,
    name: block.name,
    start,
    length: block.beatCount,
    offset: 0,
    transpose,
    sourceBlockId: block.id,
    notes: cloneBlockNotes(block, transpose),
    ...extra,
  };
  p.clips.push(clip);
  return clip;
}

function addRepeats(p: Project, track: Track, blockId: string, from: number, count: number, step?: number, transpose = 0): void {
  const b = blockById(blockId);
  const len = b ? b.beatCount : step || 8;
  for (let i = 0; i < count; i++) addClip(p, track, blockId, from + i * (step || len), transpose);
}

function baseProject(id: string, name: string, tempo: number, tracks: Track[]): Project {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    name,
    tempo,
    timeSig: [4, 4],
    loop: { enabled: true, start: 0, end: 64 },
    tracks,
    clips: [],
    master: { volume: 0.9 },
    createdAt: now,
    updatedAt: now,
  };
}

/** 示例一：夜航 Lo-fi —— 电钢、吉他、贝斯、鼓、铺底 */
function demoNightFlight(): Project {
  const tracks = [
    mkTrack(0, '电钢琴', 'ep-warm', { volume: 0.82, sendReverb: 0.28, tone: 0.88 }),
    mkTrack(1, '钢弦吉他', 'gtr-clear', { volume: 0.6, pan: 0.25, sendReverb: 0.2 }),
    mkTrack(2, '贝斯', 'bass-finger', { volume: 0.78, pan: -0.1, sendReverb: 0.06 }),
    mkTrack(3, '鼓机', 'drum-lofi', { volume: 0.7, sendReverb: 0.1 }),
    mkTrack(4, '铺底', 'pad-warm', { volume: 0.45, sendReverb: 0.5 }),
  ];
  const p = baseProject('demo-night', '夜航 Lo-fi', 88, tracks);
  const ep = tracks[0];
  const gtr = tracks[1];
  const bass = tracks[2];
  const drum = tracks[3];
  const pad = tracks[4];

  addClip(p, ep, 'ch-seventh', 0);
  addClip(p, ep, 'ch-seventh', 16);
  addClip(p, ep, 'ch-ninth', 32);
  addClip(p, ep, 'ch-seventh', 48);
  addRepeats(p, gtr, 'ch-arp', 0, 4);
  addClip(p, gtr, 'ch-arp', 32, 2);
  addRepeats(p, bass, 'bass-root', 0, 4);
  addClip(p, bass, 'bass-fifth', 32);
  addClip(p, bass, 'bass-root', 48);
  addRepeats(p, drum, 'dr-lofi', 0, 8, 8);
  addClip(p, drum, 'fill-snare', 60);
  addRepeats(p, pad, 'ch-sustain', 0, 4);

  // 自动化：铺底音色缓慢起伏
  pad.automation = [{
    paramId: 'param:cutoff',
    points: [
      { beat: 0, value: 620 },
      { beat: 16, value: 900 },
      { beat: 32, value: 700 },
      { beat: 48, value: 1100 },
      { beat: 64, value: 600 },
    ],
  }];
  return p;
}

/** 示例二：City Pulse —— 电子律动 */
function demoCityPulse(): Project {
  const tracks = [
    mkTrack(0, '温暖铺底', 'pad-warm', { volume: 0.55, sendReverb: 0.4 }),
    mkTrack(1, '锯齿主音', 'lead-saw', { volume: 0.62, pan: 0.15, sendReverb: 0.2, sendDelay: 0.15 }),
    mkTrack(2, '酸性贝斯', 'bass-acid', { volume: 0.8, sendReverb: 0.05 }),
    mkTrack(3, '电子鼓', 'drum-house', { volume: 0.78, sendReverb: 0.08 }),
    mkTrack(4, '电钢点缀', 'ep-motion', { volume: 0.5, sendReverb: 0.3 }),
  ];
  const p = baseProject('demo-city', 'City Pulse', 122, tracks);
  const pad = tracks[0];
  const lead = tracks[1];
  const bass = tracks[2];
  const drum = tracks[3];
  const ep = tracks[4];

  addRepeats(p, pad, 'ch-sustain', 0, 4);
  addRepeats(p, lead, 'mel-arp-c', 0, 4);
  addClip(p, lead, 'mel-octave', 32);
  addClip(p, lead, 'mel-repeat', 40);
  addClip(p, lead, 'mel-octave', 48);
  addClip(p, lead, 'mel-arp-c', 56);
  addRepeats(p, lead, 'mel-arp-c', 60, 1);
  addRepeats(p, bass, 'bass-funk', 0, 8, 8);
  addClip(p, bass, 'bass-sync', 32);
  addClip(p, bass, 'bass-octave', 40);
  addClip(p, bass, 'bass-funk', 48);
  addClip(p, bass, 'bass-octave', 56);
  addRepeats(p, drum, 'dr-house', 0, 8, 8);
  addClip(p, drum, 'fill-drop', 60);
  addClip(p, ep, 'ch-stabs', 16);
  addClip(p, ep, 'ch-stabs', 48);

  ep.automation = [{
    paramId: 'fx:sendReverb',
    points: [{ beat: 0, value: 0.1 }, { beat: 16, value: 0.35 }, { beat: 48, value: 0.5 }, { beat: 64, value: 0.2 }],
  }];
  return p;
}

/** 示例三：晨雾 —— 抒情氛围 */
function demoMorningMist(): Project {
  const tracks = [
    mkTrack(0, '钢琴', 'piano-soft', { volume: 0.75, sendReverb: 0.32 }),
    mkTrack(1, '暗色铺底', 'pad-dark', { volume: 0.5, sendReverb: 0.55 }),
    mkTrack(2, '木贝斯', 'bass-upright', { volume: 0.7, sendReverb: 0.08 }),
    mkTrack(3, '鼓机', 'drum-lofi', { volume: 0.5, sendReverb: 0.12 }),
    mkTrack(4, '指弹吉他', 'gtr-finger', { volume: 0.55, pan: -0.2, sendReverb: 0.25 }),
  ];
  const p = baseProject('demo-morning', '晨雾', 76, tracks);
  const piano = tracks[0];
  const pad = tracks[1];
  const bass = tracks[2];
  const drum = tracks[3];
  const gtr = tracks[4];

  addClip(p, piano, 'ch-pop-love', 0);
  addClip(p, piano, 'ch-pop-love', 16);
  addClip(p, piano, 'ch-minor', 32);
  addClip(p, piano, 'ch-pop-love', 48);
  addRepeats(p, pad, 'ch-sustain', 0, 4);
  addRepeats(p, bass, 'bass-half', 0, 8, 8);
  addRepeats(p, drum, 'dr-half', 0, 8, 8);
  addClip(p, drum, 'fill-tom', 60);
  addRepeats(p, gtr, 'ch-arp', 4, 3);
  addClip(p, gtr, 'mel-qa', 32);

  piano.automation = [{
    paramId: 'volume',
    points: [{ beat: 0, value: 0.55 }, { beat: 8, value: 0.8 }, { beat: 32, value: 0.7 }, { beat: 64, value: 0.5 }],
  }];
  return p;
}

export const DEMOS: Array<{ id: string; name: string; description: string; build: () => Project }> = [
  { id: 'demo-night', name: '夜航 Lo-fi', description: '88 BPM，电钢与吉他的慢速律动，5 轨 16 小节。', build: demoNightFlight },
  { id: 'demo-city', name: 'City Pulse', description: '122 BPM，合成器与电子鼓的都市舞曲，5 轨 16 小节。', build: demoCityPulse },
  { id: 'demo-morning', name: '晨雾', description: '76 BPM，钢琴与氛围铺底的抒情段落，5 轨 16 小节。', build: demoMorningMist },
];

export function demoById(id: string): Project | undefined {
  const d = DEMOS.find((x) => x.id === id);
  return d ? d.build() : undefined;
}
