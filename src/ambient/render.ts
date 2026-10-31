/**
 * Ambient 离线渲染（M2 Performance/Sound 层）。
 * 直接实例化浏览器 AudioWorklet 使用的同一个 StudioProcessor（无简化分支），
 * 预排事件、逐 128-sample block 渲染，输出立体声 PCM，并复用宿主 WAV 编码。
 * 与浏览器 renderOffline 共用 buildSessionPlan，避免实时/离线分叉。
 */
import { StudioProcessor } from '../audio/studio-processor.js';
import { buildSessionPlan } from '../core/session';
import { decodeAssetPcm } from '../core/audio-asset';
import { beatsToSeconds } from '../core/tempo';
import { encodeWav } from '../core/wav';
import type { Project } from '../core/types';

export interface AmbientRenderOptions {
  sampleRate?: number;
  tailSeconds?: number;
}

export interface AmbientRenderResult {
  sampleRate: number;
  /** [L, R] 立体声 Float32 */
  channels: Float32Array[];
  /** 含尾音的总时长（秒） */
  seconds: number;
  frames: number;
}

export function renderAmbient(project: Project, opts: AmbientRenderOptions = {}): AmbientRenderResult {
  const sampleRate = opts.sampleRate ?? 48000;
  const plan = buildSessionPlan(project);
  const seconds = beatsToSeconds(plan.endBeat, project.tempo) + (opts.tailSeconds ?? 1.6);
  const frames = Math.max(1, Math.ceil(seconds * sampleRate));

  const sp = new StudioProcessor({ sampleRate });

  // 素材先于事件下发；缺失 PCM 的素材不注册，对应片段将被静默跳过
  for (const asset of project.audioAssets || []) {
    const channels = decodeAssetPcm(asset);
    if (!channels) continue;
    sp.receive({ type: 'asset', assetId: asset.id, sampleRate: asset.sampleRate, channels });
  }
  // 轨道消息与实时播放共用同一构建函数：完整混音保留 mute/solo
  for (const { message } of plan.trackMessages) sp.receive(message);
  sp.receive({ type: 'master', volume: project.master.volume });

  const spb = 60 / project.tempo;
  for (const n of plan.notes) {
    sp.receive({
      type: 'note',
      track: n.trackIndex,
      pitch: n.pitch,
      velocity: n.velocity,
      when: n.startBeat * spb,
      dur: (n.endBeat - n.startBeat) * spb,
      id: `${n.clipId}:${n.noteId}`,
      art: n.articulation,
      src: 'transport',
      gen: 0,
    });
  }
  for (const a of plan.audio) {
    sp.receive({
      type: 'audio',
      track: a.trackIndex,
      assetId: a.assetId,
      when: a.startBeat * spb,
      offsetSec: a.offsetSec,
      dur: (a.endBeat - a.startBeat) * spb,
      gain: a.gain,
      id: `${a.clipId}:${a.startBeat}`,
      src: 'transport',
      gen: 0,
    });
  }
  for (const c of plan.controls) {
    sp.receive({
      type: 'track',
      track: c.trackIndex,
      when: c.beat * spb,
      src: 'automation',
      gen: 0,
      ...c.message,
    });
  }

  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const blockL = new Float32Array(128);
  const blockR = new Float32Array(128);
  const blockCount = Math.ceil(frames / 128);
  for (let b = 0; b < blockCount; b++) {
    blockL.fill(0);
    blockR.fill(0);
    sp.processBlock([blockL, blockR]);
    const start = b * 128;
    const count = Math.min(128, frames - start);
    for (let i = 0; i < count; i++) {
      L[start + i] = blockL[i];
      R[start + i] = blockR[i];
    }
  }
  return { sampleRate, channels: [L, R], seconds, frames };
}

/** 渲染为 16-bit PCM WAV 字节（复用宿主 encodeWav，与浏览器导出同一条编码路径） */
export function renderAmbientWav(project: Project, opts: AmbientRenderOptions = {}): Uint8Array {
  const { channels, sampleRate } = renderAmbient(project, opts);
  return new Uint8Array(encodeWav(channels, sampleRate));
}