import type { Project } from './types';
import { automationControls, clickSpec, clickStepAt, clicksFromStep, plannedAudioStarts, plannedNoteStarts } from './session';
import { controlAt, automationSignature } from './automation';
import type { AudioEngine } from './audio-engine';

const LOOKAHEAD = 0.14;
const RESYNC_GAP = 0.5;
const PRE_ROLL = 0.06;
const MAX_PASSES = 4096;

/**
 * 实时播放调度：以音频时钟为时间基准，提前 140ms 排程。
 *
 * 约定：
 * - 音符只在起点进入窗口时起音；长音不会因窗口推进而重触发；
 * - 循环按“当前轮次锚点”换算，窗口在循环边界处切开，下一轮从 loop.start 续排；
 * - 跨过循环边界的长音截断在边界，释音由音源包络完成；
 * - 停止/跳转/变速通过 resetSource(gen) 取消未来事件，只影响对应来源的声部；
 * - 节拍器使用独立游标，按拍号网格点击；
 * - 自动化按固定网格并行采样，与离线导出共用同一求值函数。
 */
export class Scheduler {
  private engine: AudioEngine;
  private getProject: () => Project;
  private timer = 0;
  private playing = false;

  // 播放位置锚点（真实经过的时间）
  private anchorAudio = 0;
  private anchorBeat = 0;

  // 音符排程游标（可能领先于播放位置，用于提前排下一轮）
  private schedAudio = 0;
  private schedBeat = 0;
  private scheduledUntil = 0;
  private passSeq = 0;

  // 节拍器游标
  private clickAudio = 0;
  private clickBeat = 0;
  private clickUntil = 0;
  private clickStep = 0;

  // 自动化游标
  private autoAudio = 0;
  private autoBeat = 0;
  private automationUntil = 0;

  private transportGen = 0;
  private clickGen = 0;
  private automationGen = 0;
  private lastControl = new Map<number, string>();
  private lastSig = '';
  private loopSuspended = false;

  position = 0;
  metronome = false;
  onPosition: ((beat: number) => void) | null = null;

  constructor(engine: AudioEngine, getProject: () => Project) {
    this.engine = engine;
    this.getProject = getProject;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  suspendLoop(): void {
    this.loopSuspended = true;
  }

  resumeLoop(): void {
    this.loopSuspended = false;
  }

  private spb(project: Project): number {
    return 60 / Math.max(30, project.tempo);
  }

  private loopActive(project: Project): boolean {
    const l = project.loop;
    return l.enabled && !this.loopSuspended && l.end > l.start;
  }

  private clampStart(project: Project, beat: number): number {
    let b = Math.max(0, beat);
    const l = project.loop;
    if (l.enabled && l.end > l.start && (b < l.start || b > l.end)) b = l.start;
    return b;
  }

  currentBeat(): number {
    if (!this.playing) return this.position;
    const ctx = this.engine.ctx;
    if (!ctx) return this.position;
    const project = this.getProject();
    const spb = this.spb(project);
    const now = ctx.currentTime;
    let beat = this.anchorBeat + Math.max(0, now - this.anchorAudio) / spb;
    if (this.loopActive(project)) {
      const { start, end } = project.loop;
      const endAudio = this.anchorAudio + (end - this.anchorBeat) * spb;
      if (now >= endAudio) {
        const span = (end - start) * spb;
        beat = start + ((now - endAudio) % span) / spb;
      }
    }
    return Math.max(0, beat);
  }

  async play(fromBeat: number): Promise<void> {
    await this.engine.ensure();
    const project = this.getProject();
    const start = this.clampStart(project, fromBeat);
    const now = this.engine.ctx?.currentTime || 0;
    this.cancelTransport();
    this.cancelAutomation();
    this.anchorAudio = now + PRE_ROLL;
    this.anchorBeat = start;
    this.resetCursors(project, start);
    this.lastControl.clear();
    this.lastSig = this.controlSignature(project);
    this.playing = true;
    this.position = start;
    this.startTimer();
    this.tick();
  }

  /** 停止运输：只取消 transport/click/automation，实时键盘与试听不受影响 */
  stop(): void {
    if (!this.playing) return;
    this.position = this.currentBeat();
    this.playing = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.cancelTransport();
    this.cancelAutomation();
    this.onPosition?.(this.position);
  }

  seek(beat: number): void {
    const project = this.getProject();
    this.position = this.clampStart(project, beat);
    if (!this.playing) {
      this.onPosition?.(this.position);
      return;
    }
    const now = this.engine.ctx?.currentTime || 0;
    this.cancelTransport();
    this.cancelAutomation();
    this.anchorAudio = now + PRE_ROLL;
    this.anchorBeat = this.position;
    this.resetCursors(project, this.position);
    this.lastControl.clear();
    this.lastSig = this.controlSignature(project);
    this.tick();
    this.onPosition?.(this.position);
  }

  /** 循环开关/区间变化后保持当前位置重新锚定 */
  reanchor(): void {
    if (this.playing) this.seek(this.currentBeat());
  }

  /**
   * 变速：先用旧映射捕获当前位置，再以新速度重建锚点并取消旧事件。
   * 调用方无需先改 project.tempo。
   */
  setTempo(bpm: number): void {
    const project = this.getProject();
    const clamped = Math.min(240, Math.max(30, bpm));
    if (!this.playing) {
      project.tempo = clamped;
      return;
    }
    const beat = this.currentBeat();
    project.tempo = clamped;
    const now = this.engine.ctx?.currentTime || 0;
    this.cancelTransport();
    this.cancelAutomation();
    this.anchorAudio = now;
    this.anchorBeat = beat;
    this.resetCursors(project, beat);
    this.lastControl.clear();
    this.lastSig = this.controlSignature(project);
    this.tick();
  }

  setMetronome(on: boolean): void {
    if (this.metronome === on) return;
    this.metronome = on;
    if (!this.playing) return;
    const project = this.getProject();
    this.clickGen++;
    this.engine.resetSource('click', this.clickGen);
    const now = this.engine.ctx?.currentTime || 0;
    this.clickAudio = this.anchorAudio;
    this.clickBeat = this.anchorBeat;
    this.clickUntil = now;
    this.clickStep = clickStepAt(this.currentBeat(), clickSpec(project.timeSig).gridBeats);
    this.walkClicks(project, this.spb(project), this.loopActive(project), now + LOOKAHEAD);
  }

  private startTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  private resetCursors(project: Project, beat: number): void {
    this.schedAudio = this.anchorAudio;
    this.schedBeat = beat;
    this.scheduledUntil = this.anchorAudio;
    this.passSeq = 0;
    this.clickAudio = this.anchorAudio;
    this.clickBeat = beat;
    this.clickUntil = this.anchorAudio;
    this.clickStep = clickStepAt(beat, clickSpec(project.timeSig).gridBeats);
    this.autoAudio = this.anchorAudio;
    this.autoBeat = beat;
    this.automationUntil = this.anchorAudio;
  }

  private cancelTransport(): void {
    this.transportGen++;
    this.engine.resetSource('transport', this.transportGen);
    this.clickGen++;
    this.engine.resetSource('click', this.clickGen);
  }

  private cancelAutomation(): void {
    this.automationGen++;
    this.engine.resetSource('automation', this.automationGen);
  }

  tick(): void {
    if (!this.playing) return;
    const ctx = this.engine.ctx;
    if (!ctx) return;
    // 系统休眠/音频设备切换后上下文可能被浏览器挂起，表现为界面在播但没有声音
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const project = this.getProject();
    const spb = this.spb(project);
    const useLoop = this.loopActive(project);
    const now = ctx.currentTime;

    // 后台节流或长时间卡顿：丢弃过期排程，从当前位置继续
    if (this.scheduledUntil < now - RESYNC_GAP) {
      this.resync(project, now);
    }

    this.advancePlayAnchor(now, project, spb, useLoop);
    this.syncAutomationSignature(project, now);

    const horizon = now + LOOKAHEAD;
    this.walkNotes(project, spb, useLoop, horizon);
    this.walkClicks(project, spb, useLoop, horizon);
    this.walkAutomation(project, spb, useLoop, horizon);

    this.position = this.currentBeat();
    this.onPosition?.(this.position);
  }

  private resync(project: Project, now: number): void {
    const beat = this.currentBeat();
    this.cancelTransport();
    this.cancelAutomation();
    this.anchorAudio = now;
    this.anchorBeat = beat;
    this.resetCursors(project, beat);
    this.lastControl.clear();
    this.lastSig = this.controlSignature(project);
  }

  private advancePlayAnchor(now: number, project: Project, spb: number, useLoop: boolean): void {
    if (!useLoop) return;
    const { start, end } = project.loop;
    let endAudio = this.anchorAudio + (end - this.anchorBeat) * spb;
    for (let guard = 0; guard < MAX_PASSES && now >= endAudio; guard++) {
      this.anchorAudio = endAudio;
      this.anchorBeat = start;
      endAudio = this.anchorAudio + (end - this.anchorBeat) * spb;
    }
  }

  private walkNotes(project: Project, spb: number, useLoop: boolean, horizon: number): void {
    let cursor = this.scheduledUntil;
    let pAudio = this.schedAudio;
    let pBeat = this.schedBeat;
    const timeOf = (beat: number) => pAudio + (beat - pBeat) * spb;
    for (let guard = 0; guard < MAX_PASSES && cursor < horizon - 1e-9; guard++) {
      const passEndAudio = useLoop ? timeOf(project.loop.end) : Infinity;
      if (useLoop && cursor >= passEndAudio - 1e-9) {
        pAudio = passEndAudio;
        pBeat = project.loop.start;
        cursor = passEndAudio;
        this.passSeq++;
        continue;
      }
      const segEnd = Math.min(horizon, passEndAudio);
      const fromBeat = pBeat + (cursor - pAudio) / spb;
      const toBeat = pBeat + (segEnd - pAudio) / spb;
      const passEndBeat = useLoop ? project.loop.end : Infinity;
      const notes = plannedNoteStarts(project, fromBeat, toBeat, passEndBeat);
      for (const n of notes) {
        this.engine.note(
          n.trackIndex,
          n.pitch,
          n.velocity,
          timeOf(n.startBeat),
          (n.endBeat - n.startBeat) * spb,
          `${this.transportGen}:${this.passSeq}:${n.clipId}:${n.noteId}`,
          n.articulation,
          { src: 'transport', gen: this.transportGen },
        );
      }
      for (const a of plannedAudioStarts(project, fromBeat, toBeat, passEndBeat)) {
        this.engine.audio(
          a.trackIndex,
          a.assetId,
          timeOf(a.startBeat),
          a.offsetSec,
          (a.endBeat - a.startBeat) * spb,
          a.gain,
          `${this.transportGen}:${this.passSeq}:${a.clipId}`,
          { src: 'transport', gen: this.transportGen },
        );
      }
      cursor = segEnd;
    }
    this.schedAudio = pAudio;
    this.schedBeat = pBeat;
    this.scheduledUntil = cursor;
  }

  private walkClicks(project: Project, spb: number, useLoop: boolean, horizon: number): void {
    if (!this.metronome) return;
    let cursor = this.clickUntil;
    let pAudio = this.clickAudio;
    let pBeat = this.clickBeat;
    const timeOf = (beat: number) => pAudio + (beat - pBeat) * spb;
    for (let guard = 0; guard < MAX_PASSES && cursor < horizon - 1e-9; guard++) {
      const passEndAudio = useLoop ? timeOf(project.loop.end) : Infinity;
      if (useLoop && cursor >= passEndAudio - 1e-9) {
        pAudio = passEndAudio;
        pBeat = project.loop.start;
        cursor = passEndAudio;
        this.clickStep = clickStepAt(pBeat, clickSpec(project.timeSig).gridBeats);
        continue;
      }
      const segEnd = Math.min(horizon, passEndAudio);
      const fromBeat = pBeat + (cursor - pAudio) / spb;
      const toBeat = pBeat + (segEnd - pAudio) / spb;
      const spec = clickSpec(project.timeSig);
      const firstStep = Math.max(this.clickStep, clickStepAt(fromBeat, spec.gridBeats));
      for (const c of clicksFromStep(project.timeSig, firstStep, toBeat)) {
        this.engine.metronome(timeOf(c.beat), c.accent, { src: 'click', gen: this.clickGen });
      }
      this.clickStep = Math.max(this.clickStep, clickStepAt(toBeat, spec.gridBeats));
      cursor = segEnd;
    }
    this.clickAudio = pAudio;
    this.clickBeat = pBeat;
    this.clickUntil = cursor;
  }

  private walkAutomation(project: Project, spb: number, useLoop: boolean, horizon: number): void {
    let cursor = this.automationUntil;
    let pAudio = this.autoAudio;
    let pBeat = this.autoBeat;
    const timeOf = (beat: number) => pAudio + (beat - pBeat) * spb;
    for (let guard = 0; guard < MAX_PASSES && cursor < horizon - 1e-9; guard++) {
      const passEndAudio = useLoop ? timeOf(project.loop.end) : Infinity;
      if (useLoop && cursor >= passEndAudio - 1e-9) {
        pAudio = passEndAudio;
        pBeat = project.loop.start;
        cursor = passEndAudio;
        continue;
      }
      const segEnd = Math.min(horizon, passEndAudio);
      const fromBeat = pBeat + (cursor - pAudio) / spb;
      const toBeat = pBeat + (segEnd - pAudio) / spb;
      const controls = automationControls(project, fromBeat, toBeat, this.lastControl);
      for (const c of controls) {
        this.engine.post({
          type: 'track',
          track: c.trackIndex,
          when: timeOf(c.beat),
          src: 'automation',
          gen: this.automationGen,
          ...c.message,
        });
      }
      cursor = segEnd;
    }
    this.autoAudio = pAudio;
    this.autoBeat = pBeat;
    this.automationUntil = cursor;
  }

  private controlSignature(project: Project): string {
    return project.tracks.slice(0, 15).map((t) => `${t.id}|${automationSignature(t)}`).join('||');
  }

  /**
   * 自动化 lane 增删或控制点编辑后：取消旧控制事件，立即下发当前值。
   * 删除 lane 时会用静态值覆盖，避免参数停在自动化最后值。
   */
  private syncAutomationSignature(project: Project, now: number): void {
    const sig = this.controlSignature(project);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.cancelAutomation();
    this.lastControl.clear();
    this.autoAudio = this.anchorAudio;
    this.autoBeat = this.anchorBeat;
    this.automationUntil = Math.max(now, this.engine.ctx?.currentTime || 0);
    const beat = this.currentBeat();
    project.tracks.slice(0, 15).forEach((track, i) => {
      this.engine.post({ type: 'track', track: i, ...controlAt(track, beat) });
    });
  }
}
