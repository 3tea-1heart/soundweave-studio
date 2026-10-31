/**
 * Agent 抽象（规格 §7）：每个 Agent = 音高进程 + 节奏进程 + 音区/力度/时值分布。
 * Agent 产出候选、由 Evaluator 评分、Selector 随机选取（软能量，不恒定取最低）。
 */
import type { AgentSpec, RuleOrigin } from './types';
import { createPitchProcess, createRhythmProcess, type PitchProcess, type RhythmProcess, type PitchCtx } from './processes';
import type { Rng } from './rng';
import { clamp } from './music';

export interface AgentInstance {
  spec: AgentSpec;
  pitch: PitchProcess;
  rhythm: RhythmProcess;
  origin: RuleOrigin;
  /** 本声部最近已提交音高（最近在末尾），供 voice-leading / bounded-walk */
  recent: number[];
  lastPitch: number | null;
}

export function createAgent(spec: AgentSpec, seed: string): AgentInstance {
  return {
    spec,
    pitch: createPitchProcess(spec.pitch),
    rhythm: createRhythmProcess(spec.rhythm),
    origin: {
      agentId: spec.id,
      ruleId: `${spec.pitch.id}+${spec.rhythm.id}`,
      processId: spec.pitch.id,
      seed,
    },
    recent: [],
    lastPitch: null,
  };
}

export interface Slot {
  agentId: string;
  beat: number;
  seq: number;
}

/** 按节奏进程推进生成该 Agent 在 [0, totalBeats) 内的全部起始点。 */
export function scheduleAgent(a: AgentInstance, totalBeats: number, rng: Rng): Slot[] {
  const out: Slot[] = [];
  let beat = 0;
  let seq = 0;
  while (beat < totalBeats) {
    out.push({ agentId: a.spec.id, beat, seq });
    const delta = a.rhythm.sample({ seq }, rng);
    beat += Math.max(0.0625, delta);
    seq++;
  }
  return out;
}

/** 为一个起始点采样 K 个候选音高。 */
export function samplePitches(a: AgentInstance, ctx: PitchCtx, rng: Rng, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const p = a.pitch.sample(ctx, rng);
    out.push(clamp(Math.round(p), a.spec.register.min, a.spec.register.max));
  }
  return out;
}