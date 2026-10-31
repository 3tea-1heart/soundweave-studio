import processorSource from '../audio/studio-processor.js?raw';
import type { Project, Track, InstrumentType, AudioAsset } from './types';
import { decodeAssetPcm } from './audio-asset';
import { beatsToSeconds } from './tempo';
import { buildSessionPlan, PREVIEW_TRACK_INDEX as PREVIEW_TRACK, trackMessage } from './session';
import { presetTrackFx } from './presets';
import { fetchBank, bankById, type LoadedBank } from './sample-bank';

const WORKLET_NAME = 'soundweave-studio';

/** 事件来源与代际：transport / click / automation / preview / live */
export interface SourceMeta {
  src?: string;
  gen?: number;
}

export interface OfflineOptions {
  sampleRate?: number;
  onlyTrack?: string;
  tailSeconds?: number;
  onProgress?: (done: number, total: number) => void;
}

function workletUrl(): string {
  // 去掉 ESM export 语句，Worklet 模块只需 registerProcessor
  const src = processorSource.replace(/export\s*\{[\s\S]*?\}\s*;\s*/g, '');
  return URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  ready = false;
  onLevels: ((peak: number, tracks: number[]) => void) | null = null;
  /** Worklet 自愈后的回调：主线程据此提示并重新下发工程状态 */
  onWorkletError: ((message: string) => void) | null = null;
  sampleRate = 48000;
  private previewGen = 0;
  private nodeBroken = false;
  /** 采样音源库缓存（按 id），主线程只保留 Int16 PCM */
  private bankCache = new Map<string, LoadedBank>();
  private loadingBanks = new Map<string, Promise<boolean>>();
  /** 已下发到当前 AudioWorklet 节点的库 id，节点重建后需要重新下发 */
  private banksInNode = new Set<string>();

  async ensure(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      // 节点曾因处理器异常被停用时重建，否则之后所有消息都发进了一个死节点
      if (this.nodeBroken) await this.mountNode(this.ctx);
      return this.ctx;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    // 系统休眠、锁屏或音频设备切换会把上下文挂起：自动恢复，避免“界面在播却没声音”
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    });
    const url = workletUrl();
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    await this.mountNode(ctx);
    return ctx;
  }

  private async mountNode(ctx: AudioContext): Promise<void> {
    if (this.node) {
      try {
        this.node.disconnect();
      } catch {
        /* 节点已失效，忽略 */
      }
    }
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'levels' && this.onLevels) this.onLevels(d.peak, d.tracks);
      else if (d && d.type === 'error') this.onWorkletError?.(String(d.message || '音频处理器异常'));
    };
    node.onprocessorerror = () => {
      this.nodeBroken = true;
      this.onWorkletError?.('音频节点已停止，将在下次播放前重建');
    };
    node.connect(ctx.destination);
    this.node = node;
    this.nodeBroken = false;
    this.ready = true;
    // 节点重建后把已加载的采样库补发给新节点，否则采样轨会退回合成音源
    this.banksInNode.clear();
    for (const bank of this.bankCache.values()) this.postBank(node, bank);
  }

  /** 采样音源：把库数据下发到指定节点（Int16 PCM 直接结构化克隆） */
  private postBank(node: AudioNode, bank: LoadedBank): void {
    (node as AudioWorkletNode).port.postMessage({
      type: 'sbank',
      bankId: bank.id,
      kind: bank.kind,
      sampleRate: bank.sampleRate,
      samples: bank.samples.map((s) => ({
        pitch: s.pitch,
        velMin: s.velMin,
        velMax: s.velMax,
        loopStart: s.loopStart,
        loopEnd: s.loopEnd,
        data: s.data,
      })),
    });
  }

  /** 加载采样库（幂等）；返回 false 表示清单不存在或加载失败，调用方应回退合成音源 */
  async ensureBank(bankId: string | null | undefined): Promise<boolean> {
    if (!bankId) return false;
    const def = bankById(bankId);
    if (!def) return false;
    if (this.bankCache.has(bankId)) {
      const bank = this.bankCache.get(bankId)!;
      if (this.node && !this.banksInNode.has(bankId)) {
        this.postBank(this.node, bank);
        this.banksInNode.add(bankId);
      }
      return true;
    }
    const pending = this.loadingBanks.get(bankId);
    if (pending) return pending;
    const task = (async () => {
      try {
        const bank = await fetchBank(def);
        this.bankCache.set(bankId, bank);
        if (this.node) {
          this.postBank(this.node, bank);
          this.banksInNode.add(bankId);
        }
        return true;
      } catch {
        return false;
      } finally {
        this.loadingBanks.delete(bankId);
      }
    })();
    this.loadingBanks.set(bankId, task);
    return task;
  }

  /** 预加载工程里用到的全部采样库（播放前调用，失败时静默回退合成音源） */
  async preloadBanks(project: Project): Promise<void> {
    const ids = new Set<string>();
    for (const t of project.tracks.slice(0, 15)) {
      if (t.instrument.sampleBank) ids.add(t.instrument.sampleBank);
    }
    await Promise.all([...ids].map((id) => this.ensureBank(id)));
  }

  post(msg: Record<string, unknown>): void {
    if (!this.node) return;
    this.node.port.postMessage(msg);
  }

  syncTrack(track: Track, index: number, overrides: Record<string, unknown> = {}): void {
    this.post(trackMessage(track, index, overrides));
  }

  syncProject(project: Project, opts: { muteOthersFor?: string } = {}): void {
    project.tracks.slice(0, 15).forEach((t, i) => {
      if (opts.muteOthersFor) {
        this.syncTrack(t, i, { mute: t.id !== opts.muteOthersFor, solo: false });
      } else {
        this.syncTrack(t, i);
      }
    });
    this.post({ type: 'master', volume: project.master.volume });
  }

  note(
    trackIndex: number,
    pitch: number,
    velocity: number,
    when: number,
    dur: number,
    id: string,
    art = 'normal',
    meta: SourceMeta = {},
  ): void {
    this.post({
      type: 'note',
      track: trackIndex,
      pitch,
      velocity,
      when,
      dur,
      id,
      art,
      src: meta.src || 'live',
      gen: meta.gen,
    });
  }

  noteOff(trackIndex: number, id: string, when?: number): void {
    this.post({ type: 'noteOff', track: trackIndex, id, when, src: 'live' });
  }

  allNotesOff(): void {
    this.post({ type: 'allNotesOff' });
  }

  /** 弯音：semitones 为 ±2 半音 */
  bend(trackIndex: number, semitones: number): void {
    this.post({ type: 'bend', track: trackIndex, value: semitones });
  }

  /** 触后：0–1，通道级音量/亮度调制 */
  pressure(trackIndex: number, value: number): void {
    this.post({ type: 'pressure', track: trackIndex, value });
  }

  panic(): void {
    this.post({ type: 'panic' });
  }

  /**
   * 注册 WAV 素材：PCM 在引擎侧解码后以 Float32 声道发送给 Worklet。
   * 返回 false 表示素材没有 PCM（自动保存剥离或缺失），无法播放。
   */
  registerAsset(asset: AudioAsset): boolean {
    const channels = decodeAssetPcm(asset);
    if (!channels) return false;
    this.post({
      type: 'asset',
      assetId: asset.id,
      sampleRate: asset.sampleRate,
      channels,
    });
    return true;
  }

  /** 批量注册工程内所有带 PCM 的素材（载入工程后调用） */
  syncAssets(project: Project): void {
    for (const asset of project.audioAssets || []) this.registerAsset(asset);
  }

  /** 排程一段音频素材；dur 为片段时长（秒），0 表示播放到素材结束 */
  audio(
    trackIndex: number,
    assetId: string,
    when: number,
    offsetSec: number,
    dur: number,
    gain: number,
    id: string,
    meta: SourceMeta = {},
  ): void {
    this.post({
      type: 'audio',
      track: trackIndex,
      assetId,
      when,
      offsetSec,
      dur,
      gain,
      id,
      src: meta.src || 'transport',
      gen: meta.gen,
    });
  }

  /** 按来源与代际取消事件/释放声部 */
  resetSource(src: string, gen?: number): void {
    this.post({ type: 'resetSource', src, gen });
  }

  metronome(when: number, accent: boolean, meta: SourceMeta = {}): void {
    this.post({ type: 'metronome', when, accent, src: meta.src || 'click', gen: meta.gen });
  }

  /** 预设试听 / 用户演奏使用专用预览轨，避免污染工程轨道 */
  setPreview(
    instrumentType: InstrumentType,
    params: Record<string, number>,
    volume = 0.85,
    fx: { drive?: number; chorus?: number } = {},
    sampleBank?: string,
  ): void {
    this.post({
      type: 'track',
      track: PREVIEW_TRACK,
      instrumentType,
      params,
      sampleBank: sampleBank || null,
      volume,
      pan: 0,
      mute: false,
      solo: false,
      sendReverb: 0.1,
      sendDelay: 0,
      tone: 1,
      drive: fx.drive ?? 0,
      chorus: fx.chorus ?? 0,
    });
  }

  previewNote(pitch: number, velocity: number, dur: number, id: string, art = 'normal'): void {
    this.post({
      type: 'note', track: PREVIEW_TRACK, pitch, velocity, when: 0, dur, id, art,
      src: 'preview', gen: this.previewGen,
    });
  }

  previewNoteOff(id: string): void {
    this.post({ type: 'noteOff', track: PREVIEW_TRACK, id, src: 'preview' });
  }

  async previewNotes(
    notes: Array<{ pitch: number; start: number; length: number; velocity: number }>,
    bpm: number,
    instrumentType: InstrumentType,
    params: Record<string, number>,
    art = 'normal',
    fx?: { drive?: number; chorus?: number },
    sampleBank?: string,
  ): Promise<void> {
    await this.ensure();
    if (sampleBank) await this.ensureBank(sampleBank);
    this.setPreview(instrumentType, params, 0.85, fx ?? presetTrackFx(instrumentType, params), sampleBank);
    this.previewGen++;
    this.resetSource('preview', this.previewGen);
    const origin = (this.ctx?.currentTime || 0) + 0.06;
    for (const n of notes) {
      this.post({
        type: 'note',
        track: PREVIEW_TRACK,
        pitch: n.pitch,
        velocity: n.velocity,
        when: origin + beatsToSeconds(n.start, bpm),
        dur: beatsToSeconds(n.length, bpm),
        id: `pv_${this.previewGen}_${Math.random().toString(36).slice(2)}`,
        art,
        src: 'preview',
        gen: this.previewGen,
      });
    }
  }

  async renderOffline(project: Project, opts: OfflineOptions = {}): Promise<AudioBuffer> {
    const sampleRate = opts.sampleRate || 48000;
    const plan = buildSessionPlan(project, { onlyTrack: opts.onlyTrack });
    const seconds = beatsToSeconds(plan.endBeat, project.tempo) + (opts.tailSeconds ?? 1.6);
    const frames = Math.max(1, Math.ceil(seconds * sampleRate));
    const ctx = new OfflineAudioContext(2, frames, sampleRate);
    const url = workletUrl();
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);

    // 采样音源：离线渲染用同一套采样库；缺库时对应轨道自动退回合成音源
    const bankIds = new Set<string>();
    for (const t of project.tracks.slice(0, 15)) {
      if (t.instrument.sampleBank) bankIds.add(t.instrument.sampleBank);
    }
    for (const id of bankIds) {
      const ok = await this.ensureBank(id);
      const bank = this.bankCache.get(id);
      if (ok && bank) this.postBank(node, bank);
    }

    const post = (msg: Record<string, unknown>) => node.port.postMessage(msg);
    // 素材先于事件下发；缺失 PCM 的素材不注册，对应片段将被静默跳过
    for (const asset of project.audioAssets || []) {
      const channels = decodeAssetPcm(asset);
      if (!channels) continue;
      post({ type: 'asset', assetId: asset.id, sampleRate: asset.sampleRate, channels });
    }
    // 轨道消息与实时播放共用同一构建函数：完整混音保留 mute/solo，分轨规则由计划决定
    for (const { message } of plan.trackMessages) post(message);
    post({ type: 'master', volume: project.master.volume });

    const spb = 60 / project.tempo;
    for (const n of plan.notes) {
      post({
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

    // 音频片段：与音符同一条时间轴，片段按素材原生采样率在 Worklet 内重采样
    for (const a of plan.audio) {
      post({
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

    // 自动化：与实时播放相同的固定网格采样，避免实时/离线控制值分叉
    for (const c of plan.controls) {
      post({
        type: 'track',
        track: c.trackIndex,
        when: c.beat * spb,
        src: 'automation',
        gen: 0,
        ...c.message,
      });
    }

    const buffer = await ctx.startRendering();
    return buffer;
  }

  /** 分轨导出：逐轨离线渲染（含发送效果与尾音） */
  async renderStems(project: Project, onProgress?: (done: number, total: number) => void): Promise<Array<{ track: Track; buffer: AudioBuffer }>> {
    const out: Array<{ track: Track; buffer: AudioBuffer }> = [];
    const tracks = project.tracks.slice(0, 15);
    for (let i = 0; i < tracks.length; i++) {
      out.push({ track: tracks[i], buffer: await this.renderOffline(project, { onlyTrack: tracks[i].id }) });
      onProgress?.(i + 1, tracks.length);
    }
    return out;
  }
}

export const engine = new AudioEngine();
export const PREVIEW_TRACK_INDEX = PREVIEW_TRACK;
