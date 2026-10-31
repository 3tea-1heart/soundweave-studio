/**
 * 音高进程与节奏进程（规格 §7 pitch/rhythm processes MVP）。
 * 全部实现为「纯函数」可采样接口：内部无可变状态，
 * 依赖 ctx（最近音高 / 事件序号）与传入的 Rng，保证确定性与可测试性。
 */
import type { PitchProcessSpec, RhythmProcessSpec } from './types';
import type { Rng } from './rng';
import { PC, clamp, normalizeScale } from './music';

export interface PitchCtx {
  scale: number[];
  tonic: number;
  register: { min: number; max: number };
  /** 本声部最近已提交音高（最近在末尾） */
  recent: number[];
  /** 其它声部最近音高（用于 coupling） */
  others: number[];
  /** 本声部事件序号 */
  seq: number;
}

export interface PitchProcess {
  id: PitchProcessSpec['id'];
  sample(ctx: PitchCtx, rng: Rng): number;
}

export interface RhythmCtx {
  seq: number;
}

export interface RhythmProcess {
  id: RhythmProcessSpec['id'];
  /** 返回下一次事件的等待拍数（>= 0.0625） */
  sample(ctx: RhythmCtx, rng: Rng): number;
}

/** 取一个属于 register 的音级音高（按 tonic 音级对齐，八度由 rng 选择） */
function pitchAtDegree(deg: number, tonic: number, register: { min: number; max: number }, rng: Rng): number {
  const tonicPc = PC(tonic);
  const base = tonic + (deg - tonicPc);
  const cands: number[] = [];
  for (let k = -3; k <= 3; k++) {
    const m = base + k * 12;
    if (m >= register.min && m <= register.max) cands.push(m);
  }
  if (!cands.length) return clamp(base, register.min, register.max);
  return rng.pick(cands);
}

// ----------------------------------------------------------------- 音高进程

function weightedField(spec: PitchProcessSpec): PitchProcess {
  const field = spec.field || [];
  return {
    id: 'weighted-field',
    sample(ctx, rng) {
      const pcs = normalizeScale(ctx.scale);
      const weights = pcs.map((pc, i) => (Number.isFinite(field[i]) ? field[i]! : 1));
      const deg = rng.weighted(pcs.map((pc, i) => [pc, weights[i]] as const));
      return pitchAtDegree(deg, ctx.tonic, ctx.register, rng);
    },
  };
}

function boundedWalk(spec: PitchProcessSpec): PitchProcess {
  const step = Math.max(1, spec.step ?? 2);
  return {
    id: 'bounded-walk',
    sample(ctx, rng) {
      const cur = ctx.recent.length ? ctx.recent[ctx.recent.length - 1] : center(ctx);
      const dir = rng.chance(0.5) ? 1 : -1;
      const jump = rng.int(1, step);
      let m = cur + dir * jump;
      m = snap(ctx, m);
      return clamp(m, ctx.register.min, ctx.register.max);
    },
  };
}

function irrationalRotation(spec: PitchProcessSpec): PitchProcess {
  const alpha = spec.rotation ?? 0.61803398875;
  return {
    id: 'irrational-rotation',
    sample(ctx, rng) {
      const pcs = normalizeScale(ctx.scale);
      if (!pcs.length) return center(ctx);
      const t = ctx.seq * alpha;
      const idx = ((Math.floor(t % 1 * pcs.length) % pcs.length) + pcs.length) % pcs.length;
      return pitchAtDegree(pcs[idx], ctx.tonic, ctx.register, rng);
    },
  };
}

function voiceLeading(spec: PitchProcessSpec): PitchProcess {
  const maxLeap = Math.max(1, spec.maxLeap ?? 5);
  return {
    id: 'voice-leading',
    sample(ctx, rng) {
      const cur = ctx.recent.length ? ctx.recent[ctx.recent.length - 1] : center(ctx);
      const cands = scaleCandidates(ctx);
      if (!cands.length) return clamp(cur, ctx.register.min, ctx.register.max);
      cands.sort((a, b) => {
        const da = Math.abs(a - cur);
        const db = Math.abs(b - cur);
        if (da !== db) return da - db;
        return a - b;
      });
      // 前 K 个最近音里随机选；偶尔允许较大跳跃
      if (rng.chance(0.18)) {
        const leap = cands.filter((c) => Math.abs(c - cur) <= maxLeap);
        return leap.length ? rng.pick(leap) : rng.pick(cands);
      }
      const k = Math.min(cands.length, 3);
      return cands[Math.floor(rng.next() * k)];
    },
  };
}

function center(ctx: PitchCtx): number {
  return clamp(ctx.tonic, ctx.register.min, ctx.register.max);
}

function snap(ctx: PitchCtx, midi: number): number {
  const pcs = normalizeScale(ctx.scale);
  let best = midi;
  let bestDist = Infinity;
  for (let k = -2; k <= 2; k++) {
    for (const pc of pcs) {
      const cand = (Math.floor(midi / 12) + k) * 12 + pc;
      if (cand < ctx.register.min || cand > ctx.register.max) continue;
      const d = Math.abs(cand - midi);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
  }
  return clamp(best, ctx.register.min, ctx.register.max);
}

function scaleCandidates(ctx: PitchCtx): number[] {
  const pcs = normalizeScale(ctx.scale);
  const out: number[] = [];
  for (let k = -2; k <= 2; k++) {
    for (const pc of pcs) {
      const m = (Math.floor(ctx.tonic / 12) + k) * 12 + pc;
      if (m >= ctx.register.min && m <= ctx.register.max) out.push(m);
    }
  }
  return out;
}

export function createPitchProcess(spec: PitchProcessSpec): PitchProcess {
  switch (spec.id) {
    case 'weighted-field': return weightedField(spec);
    case 'bounded-walk': return boundedWalk(spec);
    case 'irrational-rotation': return irrationalRotation(spec);
    case 'voice-leading': return voiceLeading(spec);
    default: return weightedField(spec);
  }
}

// ----------------------------------------------------------------- 节奏进程

function euclideanPattern(pulses: number, steps: number): boolean[] {
  const out = new Array<boolean>(steps).fill(false);
  if (steps <= 0) return out;
  if (pulses >= steps) return out.fill(true);
  let prev = -1;
  for (let i = 0; i < steps; i++) {
    const bucket = Math.floor((i * pulses) / steps);
    out[i] = bucket !== prev;
    prev = bucket;
  }
  return out;
}

export function createRhythmProcess(spec: RhythmProcessSpec): RhythmProcess {
  switch (spec.id) {
    case 'fixed-clock': {
      const iv = Math.max(0.125, spec.interval ?? 4);
      return { id: 'fixed-clock', sample: () => iv };
    }
    case 'near-fixed-clock': {
      const iv = Math.max(0.125, spec.interval ?? 4);
      const jit = spec.jitter ?? iv * 0.15;
      return {
        id: 'near-fixed-clock',
        sample: (_c, rng) => Math.max(0.0625, iv + rng.gaussian(0, jit)),
      };
    }
    case 'phase-drift': {
      const iv = Math.max(0.125, spec.interval ?? 4);
      const jit = spec.jitter ?? iv * 0.25;
      const period = Math.max(1, spec.driftPeriod ?? 64);
      return {
        id: 'phase-drift',
        sample(ctx, _rng) {
          const cumulative = ctx.seq * iv;
          const drift = Math.sin((2 * Math.PI * cumulative) / period) * jit;
          return Math.max(0.0625, iv + drift);
        },
      };
    }
    case 'renewal-poisson': {
      const mean = Math.max(0.125, spec.mean ?? 2);
      return {
        id: 'renewal-poisson',
        sample: (_c, rng) => Math.max(0.0625, -Math.log(1 - rng.next()) * mean),
      };
    }
    case 'euclidean': {
      const cycle = Math.max(1, Math.round(spec.cycle ?? 8));
      const pulses = Math.max(1, Math.round(spec.pulses ?? 3));
      const pattern = euclideanPattern(pulses, cycle);
      return {
        id: 'euclidean',
        sample(ctx, _rng) {
          // 从事件序号映射到脉冲位置，返回相邻脉冲间拍数（每格 1 拍）
          const totalOnsets = pattern.filter(Boolean).length;
          if (totalOnsets === 0) return cycle;
          const onsets: number[] = [];
          pattern.forEach((on, i) => { if (on) onsets.push(i); });
          const idx = ((ctx.seq % totalOnsets) + totalOnsets) % totalOnsets;
          const next = (ctx.seq + 1) % totalOnsets;
          let delta = onsets[next] - onsets[idx];
          if (delta <= 0) delta += cycle;
          return Math.max(0.0625, delta);
        },
      };
    }
    default:
      return { id: 'fixed-clock', sample: () => 4 };
  }
}