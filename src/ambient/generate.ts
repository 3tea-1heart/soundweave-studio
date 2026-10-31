/**
 * 生成入口：State → Agents 提出候选 → Evaluator 评分 → Selector 随机选取 → 输出宿主 Project。
 * 输出为标准宿主 Project（复用 core/types 的 Track/Clip/Note），
 * MIDI 导出复用 writeMidi，WAV/FLAC 渲染在 M2 接入。
 */
import type { Project, Track, Clip, Note, InstrumentState, InstrumentType, AudioAsset } from '../core/types';
import type { StylePreset, MusicEvent, AgentSpec } from './types';
import { STYLE_SCHEMA_VERSION } from './types';
import { getPreset } from './presets';
import { Rng, seedString } from './rng';
import { createAgent, scheduleAgent, samplePitches, type AgentInstance } from './agents';
import { computeFeatures, energyOf, softmaxSample, temperatureAt, voiceLeadingCost, SKIP_BIAS, type SceneCtx } from './energy';
import { presetById } from '../core/presets';
import { mergeParams } from '../core/instrument-defaults';
import { secondsToBeats } from '../core/tempo';
import { TRACK_COLORS } from '../core/project';
import { meanDissonance } from './music';
import { synthesizeTextureAsset, textureLoopSec, TEXTURE_SAMPLE_RATE } from './texture';

export interface GenerateOptions {
  presetId?: string;
  /** 直接传入完整 StylePreset（逆拟合/变体生成用），优先级高于 presetId */
  preset?: StylePreset;
  seed?: string | number;
  durationSec?: number;
  tempo?: number;
  temperature?: number;
}

export interface GenerationStats {
  presetId: string;
  seed: string;
  tempo: number;
  totalBeats: number;
  totalSeconds: number;
  trackCount: number;
  eventCount: number;
  skippedCount: number;
  acceptedRatio: number;
  meanPitch: number;
  meanVelocity: number;
  meanDissonance: number;
}

export interface GenerateResult {
  project: Project;
  stats: GenerationStats;
  /** 以 RuleOrigin 追溯的已提交事件（验收：事件→Agent/Rule/seed） */
  events: MusicEvent[];
}

const ROLE_LABEL: Record<AgentSpec['role'], string> = {
  drone: '持续低音', texture: '纹理', melody: '旋律', bass: '低音', chord: '和弦', noise: '噪声',
};

function beatsPerBarOf(preset: StylePreset): number {
  return (preset.timeSig[0] * 4) / preset.timeSig[1];
}

export function generateAmbient(opts: GenerateOptions = {}): Project {
  return generateAmbientPiece(opts).project;
}

export function generateAmbientPiece(opts: GenerateOptions = {}): GenerateResult {
  const preset = opts.preset ?? getPreset(opts.presetId ?? 'sparse-fog');
  const seed = seedString(opts.seed ?? 1);
  const master = new Rng(seed);

  const tempo = opts.tempo ?? Math.round(master.fork('tempo').uniform(preset.tempo.min, preset.tempo.max));
  const durationSec = Math.max(10, opts.durationSec ?? preset.durationSec);
  const totalBeats = secondsToBeats(durationSec, tempo);
  const bpb = beatsPerBarOf(preset);
  const windowBeats = Math.max(bpb * 4, 8);

  // 1) 建 Agent
  const agents: AgentInstance[] = preset.agents.map((spec) => createAgent(spec, seed));

  // 2) 调度起点
  const slots: Array<{ agentId: string; beat: number; seq: number }> = [];
  for (const a of agents) {
    slots.push(...scheduleAgent(a, totalBeats, master.fork(`sched:${a.spec.id}`)));
  }
  slots.sort((x, y) => x.beat - y.beat || x.agentId.localeCompare(y.agentId));

  // 3) 走时间线：提案 → 评分 → softmax 选取 → 稳态门控
  const scene: MusicEvent[] = [];
  const noteMap = new Map<string, Note[]>();
  for (const a of agents) noteMap.set(a.spec.id, []);
  let skipped = 0;

  const agentById = new Map(agents.map((a) => [a.spec.id, a]));
  const specById = new Map(preset.agents.map((s) => [s.id, s]));

  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si];
    const a = agentById.get(slot.agentId)!;
    const spec = specById.get(slot.agentId)!;
    const T = opts.temperature ?? temperatureAt(si, slots.length, preset);

    const ctx = {
      scale: preset.scales[spec.scaleRef] ?? preset.scales[Object.keys(preset.scales)[0]],
      tonic: preset.tonalCenter,
      register: spec.register,
      recent: a.recent.slice(),
      others: recentOthers(scene, spec, 16),
      seq: slot.seq,
    };
    const sceneCtx: SceneCtx = { scale: ctx.scale, tempo, beatsPerBar: bpb, windowBeats };

    const pitchRng = master.fork(`p:${slot.agentId}:${slot.seq}`);
    const pitches = samplePitches(a, ctx, pitchRng, 3);
    const dur = clampDur(spec, master.fork(`d:${slot.agentId}:${slot.seq}`));
    const vel = spec.velocity.min + (spec.velocity.max - spec.velocity.min) * master.fork(`v:${slot.agentId}:${slot.seq}`).next();

    const energies: number[] = [];
    const candEvents: MusicEvent[] = [];
    for (const p of pitches) {
      const evt: MusicEvent = {
        kind: 'Note', beat: slot.beat, pitch: p, duration: dur, velocity: vel,
        origin: { agentId: spec.id, ruleId: `${spec.pitch.id}+${spec.rhythm.id}`, processId: spec.pitch.id, seed },
      };
      const f = computeFeatures(scene, evt, slot.beat, sceneCtx);
      energies.push(energyOf(f, preset.homeostasis, voiceLeadingCost(a.lastPitch, p)));
      candEvents.push(evt);
    }
    // skip 候选（静默）
    const skipF = computeFeatures(scene, null, slot.beat, sceneCtx);
    energies.push(energyOf(skipF, preset.homeostasis, voiceLeadingCost(a.lastPitch, null)) + SKIP_BIAS);

    const pick = softmaxSample(energies, T, master.fork(`sel:${si}`));

    if (pick < candEvents.length) {
      const evt = candEvents[pick];
      scene.push(evt);
      const note: Note = {
        id: `n:${spec.id}:${slot.seq}`,
        pitch: Math.round(evt.pitch!),
        start: slot.beat,
        length: evt.duration!,
        velocity: clampVel(evt.velocity!),
        articulation: 'normal',
      };
      noteMap.get(spec.id)!.push(note);
      a.lastPitch = note.pitch;
      a.recent.push(note.pitch);
      if (a.recent.length > 32) a.recent.shift();
    } else {
      skipped++;
    }
  }

  const result = buildProject(preset, seed, tempo, totalBeats, durationSec, preset.agents, noteMap);
  const stats = buildStats(preset, seed, tempo, totalBeats, durationSec, noteMap, skipped, slots.length);
  return { project: result.project, stats, events: scene };
}

function recentOthers(scene: MusicEvent[], spec: AgentSpec, cap: number): number[] {
  const out: number[] = [];
  for (let i = scene.length - 1; i >= 0 && out.length < cap; i--) {
    const e = scene[i];
    if (e.kind === 'Note' && e.origin.agentId !== spec.id && Number.isFinite(e.pitch)) out.push(e.pitch!);
  }
  return out;
}

function clampDur(spec: AgentSpec, rng: Rng): number {
  return Math.max(0.02, rng.uniform(spec.duration.min, spec.duration.max));
}

function clampVel(v: number): number {
  return Math.max(0.05, Math.min(1, v));
}

export function buildProject(
  preset: StylePreset,
  seed: string,
  tempo: number,
  totalBeats: number,
  durationSec: number,
  specs: AgentSpec[],
  noteMap: Map<string, Note[]>,
): { project: Project } {
  const now = new Date().toISOString();
  const tracks: Track[] = [];
  const clips: Clip[] = [];

  specs.forEach((spec, i) => {
    const pres = presetById(spec.preset);
    const type: InstrumentType = pres ? pres.type : spec.instrument;
    const instrument: InstrumentState = {
      presetId: spec.preset,
      type,
      params: mergeParams(type, pres ? pres.params : undefined),
    };
    const track: Track = {
      id: `t:${spec.id}`,
      name: `${ROLE_LABEL[spec.role]} · ${spec.id}`,
      color: TRACK_COLORS[i % TRACK_COLORS.length],
      kind: 'instrument',
      instrument,
      volume: 0.8,
      pan: spec.role === 'bass' ? -0.12 : spec.role === 'melody' ? 0.12 : 0,
      mute: false,
      solo: false,
      sendReverb: spec.role === 'drone' || spec.role === 'chord' || spec.role === 'texture' ? 0.55 : 0.3,
      sendDelay: spec.role === 'texture' ? 0.22 : 0,
      tone: 0.86,
      drive: 0.03,
      chorus: spec.role === 'texture' ? 0.22 : 0,
      automation: [],
    };
    tracks.push(track);
    clips.push({
      id: `c:${spec.id}`,
      trackId: `t:${spec.id}`,
      name: `${spec.id} 片段`,
      start: 0,
      length: totalBeats,
      offset: 0,
      transpose: 0,
      notes: noteMap.get(spec.id) ?? [],
    });
  });

  // 非 MIDI 纹理声部：合成一段无缝循环素材，切成背靠背音频片段铺满全曲
  const audioAssets: AudioAsset[] = [];
  for (const tspec of preset.texture ?? []) {
    const asset = synthesizeTextureAsset({
      spec: tspec,
      seed,
      tonic: preset.tonalCenter,
      sampleRate: TEXTURE_SAMPLE_RATE,
    });
    audioAssets.push(asset);
    const texPres = presetById('pad-warm');
    const instrument: InstrumentState = texPres
      ? { presetId: texPres.id, type: texPres.type, params: mergeParams(texPres.type, texPres.params) }
      : { presetId: '', type: 'synth', params: {} };
    const ti = tracks.length;
    tracks.push({
      id: `t:texture:${tspec.id}`,
      name: `纹理 · ${tspec.id}`,
      color: TRACK_COLORS[ti % TRACK_COLORS.length],
      kind: 'audio',
      instrument,
      volume: Math.max(0.05, Math.min(1, tspec.volume)),
      pan: tspec.kind === 'shimmer' ? 0.14 : 0,
      mute: false,
      solo: false,
      sendReverb: tspec.kind === 'drone' || tspec.kind === 'noise' ? 0.4 : 0.2,
      sendDelay: 0,
      tone: 0.9,
      drive: 0,
      chorus: 0,
      automation: [],
    });
    const loopBeats = secondsToBeats(textureLoopSec(tspec), tempo);
    for (let beat = 0; beat < totalBeats - 1e-9; beat += loopBeats) {
      clips.push({
        id: `c:texture:${tspec.id}:${Math.round(beat * 1000)}`,
        trackId: `t:texture:${tspec.id}`,
        name: `${tspec.id} 纹理片段`,
        start: beat,
        length: Math.min(loopBeats, totalBeats - beat),
        offset: 0,
        transpose: 0,
        notes: [],
        audio: { assetId: asset.id, offsetSec: 0, gain: 1 },
      });
    }
  }

  const project: Project = {
    version: 1,
    id: `ga:${preset.id}:${seed}`,
    name: preset.name,
    tempo,
    timeSig: preset.timeSig,
    loop: { enabled: false, start: 0, end: totalBeats },
    tracks,
    clips,
    audioAssets,
    master: { volume: 0.9 },
    createdAt: now,
    updatedAt: now,
    ambient: { presetId: preset.id, seed, schemaVersion: STYLE_SCHEMA_VERSION, durationSec },
  };
  return { project };
}

function buildStats(
  preset: StylePreset,
  seed: string,
  tempo: number,
  totalBeats: number,
  durationSec: number,
  noteMap: Map<string, Note[]>,
  skipped: number,
  totalSlots: number,
): GenerationStats {
  const notes = Array.from(noteMap.values()).flat();
  const meanPitch = notes.length ? notes.reduce((s, n) => s + n.pitch, 0) / notes.length : 0;
  const meanVelocity = notes.length ? notes.reduce((s, n) => s + n.velocity, 0) / notes.length : 0;
  const meanDiss = notes.length >= 2 ? meanDissonance(notes.map((n) => n.pitch)) : 0;
  return {
    presetId: preset.id,
    seed,
    tempo,
    totalBeats,
    totalSeconds: durationSec,
    trackCount: noteMap.size,
    eventCount: notes.length,
    skippedCount: skipped,
    acceptedRatio: totalSlots ? (notes.length / totalSlots) : 0,
    meanPitch,
    meanVelocity,
    meanDissonance: meanDiss,
  };
}