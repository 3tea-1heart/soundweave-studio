import type { Project, Track, Clip, Note } from '../core/types';
import type { AudioEngine } from '../core/audio-engine';
import type { MidiLearnKind, MidiLearnTarget, MidiMapping } from '../core/midi-learn';

/** UI 组件与主程序之间共享的最小接口，避免组件反向依赖 main */
export interface AppUi {
  engine: AudioEngine;
  getProject(): Project;
  getSelectedTrackId(): string | null;
  getSelectedClipId(): string | null;
  getSelectedTrack(): Track | undefined;
  getSelectedClip(): Clip | undefined;
  getPlayhead(): number;
  getSnap(): number;
  getZoom(): number;
  isRecording(): boolean;
  selectTrack(id: string): void;
  selectClip(id: string | null, openEditor?: boolean): void;
  setPlayhead(beat: number, seek: boolean): void;
  commit(label?: string): void;
  softUpdate(): void;
  refresh(): void;
  notify(text: string, kind?: 'info' | 'warn' | 'error'): void;
  insertBlock(blockId: string, trackId: string, beat: number): boolean;
  recordAutomation(paramId: string, value: number): void;
  setPreviewPreset(presetId: string): void;
  liveNoteOn(pitch: number, velocity: number, art?: string): string;
  liveNoteOff(id: string): void;
  /** 把预设应用到当前选中轨道 */
  applyPreset(presetId: string): boolean;
  /** 用预览轨试听预设 */
  auditionPreset(presetId: string): void;
  /** A/B 对比：先试听候选预设，再试听当前轨道音色 */
  auditionPair(presetId: string): void;
  /** 把当前轨道的参数与效果快照存为自定义音色 */
  saveTrackAsPreset(name: string): boolean;
  /** 删除一个自定义音色 */
  removeUserPreset(id: string): void;
  /** 把当前选中片段存为自定义编曲块 */
  saveClipAsBlock(name: string): boolean;
  /** 删除一个自定义编曲块 */
  removeUserBlock(id: string): void;
  /** 开始 MIDI Learn：下一次移动的 CC 会绑定到该参数 */
  beginMidiLearn(kind: MidiLearnKind, key: string): void;
  cancelMidiLearn(): void;
  getMidiLearnTarget(): MidiLearnTarget | null;
  getMidiMappings(): MidiMapping[];
  removeMidiMapping(cc: number): void;
  /** 钢琴卷帘当前的音符选择 */
  getSelectedNotes(): Note[];
  /** 设置选中音符的力度（不修改 history；由调用方 commit） */
  setNoteVelocity(velocity: number): void;
  /** 只重绘检查器，用于选择变化 */
  refreshInspector(): void;
  /** 载入示例工程 */
  loadDemo(demoId: string): void;
  /** 生成 ambient 工程并载入（替换当前工程） */
  ambientGenerate(presetId: string, options?: { seed?: string; durationSec?: number; tempo?: number }): void;
  /** 调整音源参数（不传 commitLabel 时不进入撤销栈） */
  updateParams(patch: Record<string, number>, commitLabel?: string): void;
  /** 调整轨道效果/电平 */
  setTrackFx(field: TrackFxField, value: number, commitLabel?: string): void;
  isAutomationArmed(): boolean;
  setAutomationArmed(on: boolean): void;
  removeAutomationLane(paramId: string): void;
  deleteTrack(id: string): void;
  renameTrack(id: string, name: string): void;
}

export type TrackFxField = 'volume' | 'pan' | 'sendReverb' | 'sendDelay' | 'tone' | 'drive' | 'chorus';
