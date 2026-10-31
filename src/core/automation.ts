import type { Track, AutomationLane, AutomationPoint } from './types';
import { PARAM_DEFS } from './instrument-defaults';

/** 自动化可编辑范围：与界面滑杆/底层参数保持一致 */
export interface AutomationRange {
  min: number;
  max: number;
  step: number;
}

const FX_RANGES: Record<string, AutomationRange> = {
  volume: { min: 0, max: 1, step: 0.01 },
  pan: { min: -1, max: 1, step: 0.01 },
  sendReverb: { min: 0, max: 1, step: 0.01 },
  sendDelay: { min: 0, max: 1, step: 0.01 },
  tone: { min: 0.1, max: 1, step: 0.01 },
  drive: { min: 0, max: 1, step: 0.01 },
  chorus: { min: 0, max: 1, step: 0.01 },
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function automationRange(track: Track, paramId: string): AutomationRange {
  if (paramId.startsWith('param:')) {
    const key = paramId.slice(6);
    const def = PARAM_DEFS[track.instrument.type]?.find((d) => d.key === key);
    if (def) return { min: def.min, max: def.max, step: def.step };
    return { min: 0, max: 1, step: 0.01 };
  }
  const key = paramId.startsWith('fx:') ? paramId.slice(3) : paramId;
  return FX_RANGES[key] || { min: 0, max: 1, step: 0.01 };
}

/** lane 尚无控制点时的静态值：界面显示与播放初始状态一致 */
export function automationStaticValue(track: Track, paramId: string): number {
  if (paramId.startsWith('param:')) {
    const key = paramId.slice(6);
    return track.instrument.params[key] ?? automationRange(track, paramId).min;
  }
  const key = paramId.startsWith('fx:') ? paramId.slice(3) : paramId;
  const v = (track as unknown as Record<string, number>)[key];
  return typeof v === 'number' ? v : automationRange(track, paramId).min;
}

export function sortLanePoints(lane: AutomationLane): void {
  lane.points.sort((a, b) => a.beat - b.beat);
}

/** 在 beat 附近写入/更新控制点（录制与手绘共用） */
export function upsertLanePoint(
  lane: AutomationLane,
  beat: number,
  value: number,
  beatTolerance = 0.125,
  range?: AutomationRange,
): AutomationPoint {
  const v = range ? clamp(value, range.min, range.max) : value;
  const existing = lane.points.find((p) => Math.abs(p.beat - beat) <= beatTolerance);
  if (existing) {
    existing.beat = Math.max(0, beat);
    existing.value = v;
    sortLanePoints(lane);
    return existing;
  }
  const point: AutomationPoint = { beat: Math.max(0, beat), value: v };
  lane.points.push(point);
  sortLanePoints(lane);
  return point;
}

export function moveLanePoint(
  lane: AutomationLane,
  point: AutomationPoint,
  beat: number,
  value: number,
  range: AutomationRange,
): void {
  point.beat = Math.max(0, beat);
  point.value = clamp(value, range.min, range.max);
  sortLanePoints(lane);
}

/**
 * 手绘覆盖：删除开区间 (fromBeat, toBeat) 内的控制点，两端的点保留。
 * 与录制不同，手绘是连续写入，避免同一条曲线上留下锯齿状重复点。
 */
export function removeLanePointsInRange(lane: AutomationLane, fromBeat: number, toBeat: number): number {
  const b0 = Math.min(fromBeat, toBeat);
  const b1 = Math.max(fromBeat, toBeat);
  if (b1 - b0 < 1e-6) return 0;
  const before = lane.points.length;
  lane.points = lane.points.filter((p) => p.beat <= b0 + 1e-3 || p.beat >= b1 - 1e-3);
  return before - lane.points.length;
}

/** 删除 beat/value 附近最接近的一个控制点 */
export function removeLanePointNear(
  lane: AutomationLane,
  beat: number,
  value: number,
  beatTolerance: number,
  valueTolerance: number,
): boolean {
  let bestIdx = -1;
  let bestDist = Infinity;
  lane.points.forEach((p, i) => {
    const bd = Math.abs(p.beat - beat);
    const vd = Math.abs(p.value - value);
    if (bd <= beatTolerance && vd <= valueTolerance) {
      const d = bd + vd;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
  });
  if (bestIdx < 0) return false;
  lane.points.splice(bestIdx, 1);
  return true;
}

/** 线性插值求自动化值 */
export function laneValue(lane: AutomationLane, beat: number, fallback: number): number {
  const pts = lane.points;
  if (!pts.length) return fallback;
  if (beat <= pts[0].beat) return pts[0].value;
  if (beat >= pts[pts.length - 1].beat) return pts[pts.length - 1].value;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (beat >= a.beat && beat <= b.beat) {
      const t = b.beat === a.beat ? 0 : (beat - a.beat) / (b.beat - a.beat);
      return a.value + (b.value - a.value) * t;
    }
  }
  return fallback;
}

export function laneById(track: Track, paramId: string): AutomationLane | undefined {
  return track.automation.find((l) => l.paramId === paramId);
}

/**
 * 生成某轨道在 beat 时刻的完整控制消息：静态值 + 自动化覆盖。
 * 实时播放与离线导出的控制事件都由它求值，保证两条路径一致。
 */
export function controlAt(track: Track, beat: number): Record<string, unknown> {
  const params: Record<string, number> = { ...track.instrument.params };
  const msg: Record<string, unknown> = {
    params,
    volume: track.volume,
    pan: track.pan,
    sendReverb: track.sendReverb,
    sendDelay: track.sendDelay,
    tone: track.tone,
    drive: track.drive,
    chorus: track.chorus,
  };
  for (const lane of track.automation) {
    if (!lane.points.length) continue;
    const id = lane.paramId;
    if (id.startsWith('param:')) {
      const key = id.slice(6);
      params[key] = laneValue(lane, beat, track.instrument.params[key] ?? 0);
      continue;
    }
    const key = id.startsWith('fx:') ? id.slice(3) : id;
    if (key === 'volume' || key === 'pan' || key === 'sendReverb' || key === 'sendDelay'
      || key === 'tone' || key === 'drive' || key === 'chorus') {
      msg[key] = laneValue(lane, beat, track[key]);
    }
  }
  return msg;
}

/** 自动化编辑指纹：lane、点数或任意控制点变化都会改变它 */
export function automationSignature(track: Track): string {
  return track.automation
    .map((l) => `${l.paramId}:${l.points.map((p) => `${p.beat}=${p.value}`).join(',')}`)
    .join('|');
}

/** 参数显示名 */
export function automationLabel(paramId: string): string {
  const labels: Record<string, string> = {
    volume: '音量', pan: '声像', sendReverb: '混响发送', sendDelay: '延迟发送',
    tone: '音色低通', drive: '过载', chorus: '合唱',
    'param:cutoff': '滤波截止', 'param:index': 'FM 深度', 'param:bright': '亮度',
    'param:brightness': '明亮度', 'param:damping': '阻尼', 'param:resonance': '共振',
    'param:lfoDepth': '调制深度', 'param:sub': '子振荡器',
    'fx:sendReverb': '混响发送', 'fx:chorus': '合唱', 'fx:tone': '音色低通',
  };
  if (labels[paramId]) return labels[paramId];
  if (paramId.startsWith('param:')) return paramId.slice(6);
  return paramId;
}
