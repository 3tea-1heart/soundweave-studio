/**
 * Infinite Radio（M5）。
 * rolling horizon：不一次生成无限事件，而是维护一个可增量推进的 RadioSession，
 * 每次 `radioAdvance(session, seconds)` 只补未来一段，事件持续追加且跨段无缝。
 *
 * 与一次性 generateAmbientPiece 的关键差异：
 * - 保存每个 Agent 的调度游标（nextBeat / seq / rhythm Rng 状态）、最近记忆（recent / lastPitch）、
 *   稳态副本与 scene 窗口，因此段间 pitch-center / voice-leading / homeostasis 连续。
 * - macro environment 以分钟尺度确定性漂移（tonic / density 目标），叠加 recurrence guard 防短循环。
 * - checkpoint/resume 通过 radioExportState / radioImportState（含 Rng state）实现；
 *   pitch/dur/vel/selector 的 Rng 由恒定 master + 派生标签确定性重建，无需保存其 state。
 * - Capture：radioCaptureLast 把最近 N 秒固化为普通可编辑工程（复用 buildProject）。
 * 全程确定性：同 seed 连续生成或中途 checkpoint 再 resume，产出序列一致。
 */
import type { Project, Note } from '../core/types';
import type { StylePreset, MusicEvent, HomeostasisTarget } from './types';
import type { PitchCtx } from './processes';
import type { SceneCtx } from './energy';
import type { AgentInstance } from './agents';
import { createAgent, samplePitches } from './agents';
import { computeFeatures, energyOf, softmaxSample, voiceLeadingCost, SKIP_BIAS } from './energy';
import { Rng, seedString } from './rng';
import { clamp } from './music';
import { secondsToBeats } from '../core/tempo';
import { buildProject } from './generate';

const TWO_PI = Math.PI * 2;
/** 短循环命中时的能量惩罚（强抑制，迫使选择器跳出重复） */
const LOOP_PENALTY = 5;

export interface RadioOptions {
  seed?: string | number;
  tempo?: number;
}

interface RadioAgent {
  inst: AgentInstance;
  nextBeat: number;
  seq: number;
  rhythmRng: Rng;
}

export interface RadioSession {
  preset: StylePreset;
  seed: string;
  tempo: number;
  bpb: number;
  windowBeats: number;
  sceneWindowBeats: number;
  cursorBeat: number;
  globalSeq: number;
  elapsedSec: number;
  macroTonic: number;
  homeostasis: HomeostasisTarget;
  agents: RadioAgent[];
  /** 最近窗口已提交事件（供 evaluator 计算特征与 coupling） */
  scene: MusicEvent[];
  /** 按 agentId 分组的全量已接受音符（capture / retention 裁剪用） */
  noteMap: Map<string, Note[]>;
  /** 最近音高级序列（recurrence guard） */
  history: number[];
  retentionSec: number;
}

export interface RadioAgentState {
  id: string;
  nextBeat: number;
  seq: number;
  recent: number[];
  lastPitch: number | null;
  rhythmRngState: number;
}

export interface RadioState {
  version: number;
  preset: StylePreset;
  seed: string;
  tempo: number;
  cursorBeat: number;
  globalSeq: number;
  elapsedSec: number;
  macroTonic: number;
  homeostasis: HomeostasisTarget;
  agents: RadioAgentState[];
  scene: MusicEvent[];
  noteMap: Record<string, Note[]>;
  history: number[];
}

function recentOthers(scene: MusicEvent[], agentId: string, cap: number): number[] {
  const out: number[] = [];
  for (let i = scene.length - 1; i >= 0 && out.length < cap; i--) {
    const e = scene[i];
    if (e.kind === 'Note' && e.origin.agentId !== agentId && Number.isFinite(e.pitch)) out.push(e.pitch!);
  }
  return out;
}

/** 检测候选音级加入后是否形成明显短周期（递归 window ≤ MAX_PERIOD，吻合度阈值 0.92） */
function wouldShortLoop(history: number[], candidatePc: number): boolean {
  const pcs = history.slice(-31).concat([candidatePc]);
  const n = pcs.length;
  if (n < 12) return false;
  for (let p = 1; p <= 8; p++) {
    let match = 0;
    let total = 0;
    for (let i = p; i < n; i++) {
      total++;
      if (pcs[i] === pcs[i - p]) match++;
    }
    if (total > 0 && match / total > 0.92) return true;
  }
  return false;
}

function clampInterval(iv: { min: number; max: number }, delta: number): { min: number; max: number } {
  const a = clamp(iv.min + delta, 0, 1);
  const b = clamp(iv.max + delta, 0, 1);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

/** macro environment 分钟尺度漂移（确定性，仅依赖 elapsedSec） */
function applyMacro(session: RadioSession): void {
  const t = session.elapsedSec;
  const drift = Math.round(Math.sin((t / 61) * TWO_PI) * 2 + Math.sin((t / 211) * TWO_PI) * 1);
  session.macroTonic = clamp(session.preset.tonalCenter + drift, 36, 66);
  const d = 0.08 * Math.sin((t / 137) * TWO_PI) + 0.05 * Math.sin((t / 43) * TWO_PI);
  session.homeostasis.density = clampInterval(session.preset.homeostasis.density, d);
}

function trimSession(session: RadioSession): void {
  const rBeat = session.cursorBeat - secondsToBeats(session.retentionSec, session.tempo);
  for (const [k, arr] of session.noteMap) session.noteMap.set(k, arr.filter((n) => n.start >= rBeat));
  const winStart = session.cursorBeat - session.sceneWindowBeats;
  session.scene = session.scene.filter((e) => e.beat + (e.duration ?? 0) >= winStart);
}

export function createRadioSession(preset: StylePreset, opts: RadioOptions = {}): RadioSession {
  const seed = seedString(opts.seed ?? 'radio');
  const tempo = opts.tempo ?? Math.round(new Rng(seed + ':radio:tempo').uniform(preset.tempo.min, preset.tempo.max));
  const bpb = (preset.timeSig[0] * 4) / preset.timeSig[1];
  const windowBeats = Math.max(bpb * 4, 8);
  const agents: RadioAgent[] = preset.agents.map((spec) => ({
    inst: createAgent(spec, seed),
    nextBeat: 0,
    seq: 0,
    rhythmRng: new Rng(seedString(`${seed}:radio:sched:${spec.id}`)),
  }));
  const noteMap = new Map<string, Note[]>();
  for (const spec of preset.agents) noteMap.set(spec.id, []);
  return {
    preset,
    seed,
    tempo,
    bpb,
    windowBeats,
    sceneWindowBeats: windowBeats * 3,
    cursorBeat: 0,
    globalSeq: 0,
    elapsedSec: 0,
    macroTonic: preset.tonalCenter,
    homeostasis: JSON.parse(JSON.stringify(preset.homeostasis)),
    agents,
    scene: [],
    noteMap,
    history: [],
    retentionSec: 600,
  };
}

/** 向前生成 `seconds` 秒事件，返回本段新增的已提交 MusicEvent，并更新 session 状态 */
export function radioAdvance(session: RadioSession, seconds: number): MusicEvent[] {
  applyMacro(session);
  const toBeat = session.cursorBeat + secondsToBeats(seconds, session.tempo);

  const slots: Array<{ agentId: string; beat: number; seq: number }> = [];
  for (const a of session.agents) {
    while (a.nextBeat < toBeat) {
      slots.push({ agentId: a.inst.spec.id, beat: a.nextBeat, seq: a.seq });
      const delta = a.inst.rhythm.sample({ seq: a.seq }, a.rhythmRng);
      a.nextBeat += Math.max(0.0625, delta);
      a.seq++;
    }
  }
  slots.sort((x, y) => x.beat - y.beat || x.agentId.localeCompare(y.agentId));

  const agentById = new Map(session.agents.map((a) => [a.inst.spec.id, a]));
  const specById = new Map(session.preset.agents.map((s) => [s.id, s]));
  const master = new Rng(session.seed);
  const T = (session.preset.temperature.min + session.preset.temperature.max) / 2;

  const emitted: MusicEvent[] = [];

  for (const slot of slots) {
    const a = agentById.get(slot.agentId)!;
    const spec = specById.get(slot.agentId)!;
    const scale = session.preset.scales[spec.scaleRef] ?? session.preset.scales[Object.keys(session.preset.scales)[0]];

    const ctx: PitchCtx = {
      scale,
      tonic: session.macroTonic,
      register: spec.register,
      recent: a.inst.recent.slice(),
      others: recentOthers(session.scene, spec.id, 16),
      seq: slot.seq,
    };
    const sceneCtx: SceneCtx = { scale, tempo: session.tempo, beatsPerBar: session.bpb, windowBeats: session.windowBeats };

    const pitches = samplePitches(a.inst, ctx, master.fork(`radio:p:${slot.agentId}:${slot.seq}`), 3);
    const dur = Math.max(0.02, master.fork(`radio:d:${slot.agentId}:${slot.seq}`).uniform(spec.duration.min, spec.duration.max));
    const vel = spec.velocity.min + (spec.velocity.max - spec.velocity.min) * master.fork(`radio:v:${slot.agentId}:${slot.seq}`).next();

    const energies: number[] = [];
    const candEvents: MusicEvent[] = [];
    for (const p of pitches) {
      const evt: MusicEvent = {
        kind: 'Note',
        beat: slot.beat,
        pitch: p,
        duration: dur,
        velocity: vel,
        origin: { agentId: spec.id, ruleId: `${spec.pitch.id}+${spec.rhythm.id}`, processId: spec.pitch.id, seed: session.seed },
      };
      const f = computeFeatures(session.scene, evt, slot.beat, sceneCtx);
      let e = energyOf(f, session.homeostasis, voiceLeadingCost(a.inst.lastPitch, p));
      if (wouldShortLoop(session.history, ((p % 12) + 12) % 12)) e += LOOP_PENALTY;
      energies.push(e);
      candEvents.push(evt);
    }
    const skipF = computeFeatures(session.scene, null, slot.beat, sceneCtx);
    energies.push(energyOf(skipF, session.homeostasis, voiceLeadingCost(a.inst.lastPitch, null)) + SKIP_BIAS);

    const pick = softmaxSample(energies, T, master.fork(`radio:sel:${session.globalSeq}`));
    session.globalSeq++;

    if (pick < candEvents.length) {
      const evt = candEvents[pick];
      const pitch = Math.round(evt.pitch!);
      const note: Note = {
        id: `n:${spec.id}:${slot.seq}`,
        pitch,
        start: slot.beat,
        length: evt.duration!,
        velocity: Math.max(0.05, Math.min(1, evt.velocity!)),
        articulation: 'normal',
      };
      session.noteMap.get(spec.id)!.push(note);
      session.scene.push(evt);
      session.history.push(((pitch % 12) + 12) % 12);
      if (session.history.length > 128) session.history.shift();
      a.inst.lastPitch = pitch;
      a.inst.recent.push(pitch);
      if (a.inst.recent.length > 32) a.inst.recent.shift();
      emitted.push(evt);
    }
  }

  session.cursorBeat = toBeat;
  session.elapsedSec += seconds;
  trimSession(session);
  return emitted;
}

/** 把最近 `seconds` 秒固化为普通可编辑工程（复用 buildProject，含 MIDI + 纹理轨） */
export function radioCaptureLast(session: RadioSession, seconds: number): Project {
  const startBeat = session.cursorBeat - secondsToBeats(seconds, session.tempo);
  const totalBeats = session.cursorBeat - startBeat;
  const noteMap = new Map<string, Note[]>();
  for (const spec of session.preset.agents) noteMap.set(spec.id, []);
  for (const [id, arr] of session.noteMap) {
    const rel = arr.filter((n) => n.start >= startBeat).map((n) => ({ ...n, start: n.start - startBeat }));
    noteMap.set(id, rel);
  }
  return buildProject(session.preset, session.seed, session.tempo, totalBeats, seconds, session.preset.agents, noteMap).project;
}

export function radioExportState(session: RadioSession): RadioState {
  return {
    version: 1,
    preset: session.preset,
    seed: session.seed,
    tempo: session.tempo,
    cursorBeat: session.cursorBeat,
    globalSeq: session.globalSeq,
    elapsedSec: session.elapsedSec,
    macroTonic: session.macroTonic,
    homeostasis: JSON.parse(JSON.stringify(session.homeostasis)),
    agents: session.agents.map((a) => ({
      id: a.inst.spec.id,
      nextBeat: a.nextBeat,
      seq: a.seq,
      recent: a.inst.recent.slice(),
      lastPitch: a.inst.lastPitch,
      rhythmRngState: a.rhythmRng.getState(),
    })),
    scene: session.scene.map((e) => ({ ...e })),
    noteMap: Object.fromEntries(Array.from(session.noteMap.entries()).map(([k, v]) => [k, v.map((n) => ({ ...n }))])),
    history: session.history.slice(),
  };
}

export function radioImportState(state: RadioState): RadioSession {
  const session = createRadioSession(state.preset, { seed: state.seed, tempo: state.tempo });
  for (const sa of state.agents) {
    const a = session.agents.find((x) => x.inst.spec.id === sa.id)!;
    a.nextBeat = sa.nextBeat;
    a.seq = sa.seq;
    a.inst.recent = sa.recent.slice();
    a.inst.lastPitch = sa.lastPitch;
    a.rhythmRng.setState(sa.rhythmRngState);
  }
  session.cursorBeat = state.cursorBeat;
  session.globalSeq = state.globalSeq;
  session.elapsedSec = state.elapsedSec;
  session.macroTonic = state.macroTonic;
  session.homeostasis = JSON.parse(JSON.stringify(state.homeostasis));
  session.scene = state.scene.map((e) => ({ ...e }));
  session.noteMap = new Map(Object.entries(state.noteMap).map(([k, v]) => [k, v.map((n) => ({ ...n }))]));
  session.history = state.history.slice();
  return session;
}