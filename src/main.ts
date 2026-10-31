import './style.css';
import type { Project, Track, Clip, Note, InstrumentType, AutomationLane, Preset, PresetFx } from './core/types';
import { engine } from './core/audio-engine';
import {
  createEmptyProject, createClip, createAudioClip, createTrack, parseProject, serializeProject, uid, findTrack, findClip,
  nextClipStart,
} from './core/project';
import { createAudioAsset, adoptAudioAsset, stripAssetData, MAX_ASSET_SECONDS } from './core/audio-asset';
import { History } from './core/history';
import { Scheduler } from './core/scheduler';
import { beatsPerBarOf, beatsToSeconds, formatBeat } from './core/tempo';
import { upsertLanePoint } from './core/automation';
import { presetById, defaultPresetForType, auditionNotes, auditionMinLength, presetTrackFx } from './core/presets';
import { mergeParams } from './core/instrument-defaults';
import { addUserPreset, removeUserPreset as removePresetEntry } from './core/user-presets';
import { blockById, cloneBlockNotes } from './core/blocks';
import { addUserBlock, removeUserBlock as removeBlockEntry, blockFromClipNotes } from './core/user-blocks';
import { demoById } from './core/demos';
import { encodeWav, decodeWav, downloadBlob, safeFileName } from './core/wav';
import { writeMidi, parseMidi, guessTypeFromProgram } from './core/midi';
import { MidiInput } from './core/midi-input';
import {
  loadMidiMappings, saveMidiMappings, upsertMapping, removeMapping, mappingFor, applyMidiRaw,
  targetRange, targetLabel, type MidiMapping, type MidiLearnKind, type MidiLearnTarget,
} from './core/midi-learn';
import { Timeline } from './ui/timeline';
import { PianoRoll } from './ui/pianoroll';
import { Mixer } from './ui/mixer';
import { Keyboard } from './ui/keyboard';
import { Browser } from './ui/browser';
import { Inspector } from './ui/inspector';
import type { AppUi, TrackFxField } from './ui/context';
import { generateAmbientPiece } from './ambient';
import { pushRetro, retroToNotes, type RetroEvent } from './core/retro';
import { SCALES, scaleById, diatonicChords, suggestChord, noteName, type Chord } from './core/scales';

const AUTOSAVE_KEY = 'soundweave.autosave.v1';
const MAX_TRACKS = 15;
const VALID_TYPES: InstrumentType[] = ['ep', 'piano', 'guitar', 'synth', 'bass', 'drum'];

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function normalizeProject(p: Project): Project {
  p.version = 1;
  p.tempo = clamp(Number.isFinite(p.tempo) ? p.tempo : 100, 30, 240);
  p.timeSig = p.timeSig || [4, 4];
  p.loop = p.loop || { enabled: true, start: 0, end: 16 };
  if (!Number.isFinite(p.loop.start)) p.loop.start = 0;
  if (!Number.isFinite(p.loop.end) || p.loop.end <= p.loop.start) p.loop.end = p.loop.start + 8;
  p.master = p.master || { volume: 0.9 };
  p.audioAssets = Array.isArray(p.audioAssets) ? p.audioAssets : [];
  p.tracks = (p.tracks || []).slice(0, MAX_TRACKS);
  for (const t of p.tracks) {
    if (!VALID_TYPES.includes(t.instrument?.type)) {
      t.instrument = { presetId: 'lead-bright', type: 'synth', params: {} };
    }
    const preset = presetById(t.instrument.presetId);
    if (!preset || preset.type !== t.instrument.type) {
      t.instrument.presetId = defaultPresetForType(t.instrument.type).id;
    }
    t.instrument.params = mergeParams(t.instrument.type, t.instrument.params);
    t.automation = t.automation || [];
    if (!t.name) t.name = '轨道';
    if (!t.color) t.color = '#7aa2ff';
  }
  p.clips = (p.clips || []).filter((c) => p.tracks.some((t) => t.id === c.trackId) && Array.isArray(c.notes));
  for (const c of p.clips) {
    c.notes.forEach((n) => {
      n.velocity = clamp(n.velocity ?? 0.7, 0.05, 1);
      n.length = Math.max(0.01, n.length || 0.25);
    });
  }
  return p;
}

function loadAutosave(): Project | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    return normalizeProject(parseProject(text));
  } catch {
    return null;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

class App implements AppUi {
  readonly engine = engine;
  project: Project;
  private history = new History();
  private scheduler: Scheduler;
  private timeline!: Timeline;
  private pianoroll!: PianoRoll;
  private mixer!: Mixer;
  private keyboard!: Keyboard;
  private browser!: Browser;
  private inspector!: Inspector;

  private selectedTrackId: string | null = null;
  private selectedClipId: string | null = null;
  private playhead = 0;
  private snap = 0.25;
  private zoom = 1;
  private recording = false;
  private automationArmed = true;
  private metronome = false;
  private needsDraw = true;
  private busy = false;
  private helpOpen = false;
  private liveSeq = 0;
  private liveIds = new Map<string, number>();
  private midi: MidiInput | null = null;
  private midiHeld = new Map<number, string>();
  private midiMappings: MidiMapping[] = [];
  private midiLearn: MidiLearnTarget | null = null;
  private pendingNotes = new Map<string, () => void>();
  private recNotes = new Map<string, { note: Note; absStart: number }>();
  private retroBuffer: RetroEvent[] = [];
  private retroActive = new Map<string, RetroEvent>();
  private scaleRoot = 0;
  private scaleType = 'major';
  private chords: Chord[] = [];
  private highlightedChordKey = '';
  private saveTimer = 0;
  private lastPositionText = '';
  /** 已发送给 Worklet 的素材 id，避免每次 softUpdate 重复拷贝 PCM */
  private registeredAssets = new Set<string>();
  /** 导入进行中：同一时间只处理一次，防止重复派发的 change 把同一文件导两次 */
  private importingWav = false;
  /** 上一次成功导入的素材与时刻：吞掉同一次操作被连派两遍的 change 事件 */
  private lastImport: { assetId: string; at: number } | null = null;

  constructor() {
    const restored = loadAutosave();
    this.project = restored || normalizeProject(createEmptyProject());
    this.selectedTrackId = this.project.tracks[0]?.id ?? null;
    this.selectedClipId = this.project.clips[0]?.id ?? null;

    this.scheduler = new Scheduler(engine, () => this.project);
    this.scheduler.onPosition = (beat) => {
      if (this.scheduler.isPlaying) {
        this.playhead = beat;
        this.needsDraw = true;
        this.updatePositionLabel();
      }
    };

    engine.onLevels = (_peak, tracks) => {
      this.mixer?.setLevels(tracks);
    };
    // 音频线程异常/节点被停用后自行恢复：提示用户并重新下发工程状态
    engine.onWorkletError = (message) => {
      this.notify(`音频引擎已自动恢复：${message}`, 'warn');
      engine.syncProject(this.project);
    };

    this.timeline = new Timeline($<HTMLCanvasElement>('timeline-canvas'), this);
    this.pianoroll = new PianoRoll($<HTMLCanvasElement>('pianoroll-canvas'), this);
    this.mixer = new Mixer($('mixer'), this);
    this.keyboard = new Keyboard($('keyboard'), this);
    this.browser = new Browser($('browser'), this);
    this.inspector = new Inspector($('inspector'), this);

    this.history.reset(this.project);
    this.midiMappings = loadMidiMappings();
    this.bindTransport();
    this.bindFiles();
    this.bindShortcuts();
    this.bindResizers();
    this.bindHelp();
    this.initChordBar();
    this.updateViewButtons();
    $('btn-midi').onclick = () => void this.initMidi();
    // 切走窗口时释放按住的 MIDI 音，避免回到页面后仍有挂音
    window.addEventListener('blur', () => {
      this.midi?.releaseAll();
      this.midiHeld.clear();
    });
    this.refresh();
    this.updatePositionLabel();
    this.requestFrame();
    window.addEventListener('beforeunload', () => this.saveLocal());
    if (restored) {
      const missing = this.missingAssetCount();
      if (missing) {
        this.notify(`已恢复自动保存；${missing} 个音频素材缺少 PCM，请重新导入对应 WAV 后播放`, 'warn');
      } else {
        this.notify('已恢复上次自动保存的工程');
      }
    }
  }

  // ---------------- AppUi ----------------
  getProject(): Project { return this.project; }
  getSelectedTrackId(): string | null { return this.selectedTrackId; }
  getSelectedClipId(): string | null { return this.selectedClipId; }
  getSelectedTrack(): Track | undefined { return findTrack(this.project, this.selectedTrackId); }
  getSelectedClip(): Clip | undefined { return findClip(this.project, this.selectedClipId); }
  getPlayhead(): number { return this.playhead; }
  getSnap(): number { return this.snap; }
  getZoom(): number { return this.zoom; }
  isRecording(): boolean { return this.recording; }

  selectTrack(id: string): void {
    if (!this.project.tracks.some((t) => t.id === id)) return;
    this.selectedTrackId = id;
    const clip = this.getSelectedClip();
    if (clip && clip.trackId !== id) this.selectedClipId = null;
    this.keyboard?.rebuild();
    this.refresh();
  }

  selectClip(id: string | null, openEditor = false): void {
    this.selectedClipId = id;
    const clip = id ? findClip(this.project, id) : undefined;
    if (clip) {
      this.selectedTrackId = clip.trackId;
      this.keyboard?.rebuild();
    }
    void openEditor;
    this.refresh();
  }

  setPlayhead(beat: number, seek: boolean): void {
    this.playhead = Math.max(0, beat);
    if (seek) this.scheduler.seek(this.playhead);
    this.needsDraw = true;
    this.updatePositionLabel();
    this.updateInfo();
  }

  commit(label = '编辑'): void {
    this.history.push(this.project);
    this.saveLocal();
    this.refresh();
    this.notify(label);
  }

  softUpdate(): void {
    this.syncAudio();
    this.timeline?.render();
    this.pianoroll?.render();
    this.queueSave();
  }

  refresh(): void {
    this.timeline?.render();
    this.pianoroll?.render();
    this.mixer?.render();
    this.inspector?.render();
    this.browser?.render();
    this.updateTransport();
    this.updateInfo();
    this.updatePositionLabel();
    this.needsDraw = true;
  }

  notify(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    const el = $('status');
    el.textContent = text;
    el.className = kind === 'info' ? '' : kind;
    // 重新触发状态栏的过渡动画（先移除再重排后加回）
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  insertBlock(blockId: string, trackId: string, beat: number): boolean {
    const block = blockById(blockId);
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!block || !track) return false;
    if (track.kind === 'audio') {
      this.notify('音频轨不能插入音符编曲块；请用文件栏「导入 WAV」', 'warn');
      return false;
    }
    const start = Math.max(0, Math.round(beat * 4) / 4);
    const clip: Clip = {
      id: uid('c'),
      trackId,
      name: block.name,
      start,
      length: block.beatCount,
      offset: 0,
      transpose: 0,
      sourceBlockId: block.id,
      notes: cloneBlockNotes(block, 0),
    };
    this.project.clips.push(clip);
    this.selectedTrackId = trackId;
    this.selectedClipId = clip.id;
    this.keyboard.rebuild();
    this.commit(`插入编曲块「${block.name}」`);
    return true;
  }

  recordAutomation(paramId: string, value: number): void {
    if (!this.automationArmed || !this.recording || !this.scheduler.isPlaying) return;
    const track = this.getSelectedTrack();
    if (!track) return;
    const beat = this.scheduler.currentBeat();
    let lane = track.automation.find((l) => l.paramId === paramId);
    if (!lane) {
      lane = { paramId, points: [] };
      track.automation.push(lane);
    }
    const last = lane.points[lane.points.length - 1];
    if (last && Math.abs(beat - last.beat) < 0.1) {
      last.value = value;
    } else {
      upsertLanePoint(lane, beat, value, 0.1);
    }
    if (lane.points.length > 800) {
      lane.points = lane.points.filter((_, i) => i % 2 === 0 || i === lane.points.length - 1);
    }
    this.queueSave();
  }

  setPreviewPreset(presetId: string): void {
    const preset = presetById(presetId);
    if (!preset) return;
    engine.setPreview(preset.type, mergeParams(preset.type, preset.params), 0.85, this.presetAuditionFx(preset));
  }

  /** 试听用的轨道效果：自定义音色用保存时的快照，内置预设按参数推导 */
  private presetAuditionFx(preset: Preset): { drive: number; chorus: number } {
    if (preset.fx) {
      return { drive: clamp(preset.fx.drive ?? 0, 0, 1), chorus: clamp(preset.fx.chorus ?? 0, 0, 1) };
    }
    return presetTrackFx(preset.type, preset.params);
  }

  liveNoteOn(pitch: number, velocity: number, art = 'normal'): string {
    const id = `ln_${++this.liveSeq}`;
    const track = this.getSelectedTrack();
    // 音频轨没有合成声部：键盘/MIDI 演奏与录制都不作用，避免“音频”轨发出合成器声音
    if (!track || track.kind === 'audio') return id;
    const index = this.project.tracks.indexOf(track);
    if (index < 0) return id;
    const send = () => engine.note(index, pitch, velocity, 0, 0, id, art);
    if (engine.ready) send();
    else {
      this.pendingNotes.set(id, send);
      void engine.ensure()
        .then(() => {
          engine.syncProject(this.project);
          const fn = this.pendingNotes.get(id);
          if (fn) {
            this.pendingNotes.delete(id);
            fn();
          }
        })
        .catch(() => this.pendingNotes.delete(id));
    }
    this.liveIds.set(id, index);

    // 回溯录制：即使未按录制键，也把实时演奏记入滚动缓冲，供之后找回灵感
    if (!this.recording) {
      const nowBeat = this.scheduler.isPlaying ? this.scheduler.currentBeat() : this.playhead;
      this.retroActive.set(id, {
        pitch,
        velocity,
        articulation: art === 'mute' ? 'mute' : 'normal',
        start: nowBeat,
        length: 0.0625,
      });
    }

    if (this.recording && this.scheduler.isPlaying) {
      const clip = this.getSelectedClip();
      if (clip && clip.trackId === track.id) {
        const beat = this.scheduler.currentBeat();
        const local = beat - clip.start + clip.offset;
        if (local >= 0 && local <= clip.length) {
          const note: Note = {
            id,
            pitch,
            start: local,
            length: Math.max(0.0625, this.snap),
            velocity,
            articulation: art === 'mute' ? 'mute' : 'normal',
          };
          clip.notes.push(note);
          this.recNotes.set(id, { note, absStart: beat });
          this.needsDraw = true;
        }
      }
    }
    return id;
  }

  liveNoteOff(id: string): void {
    const pending = this.pendingNotes.get(id);
    if (pending) {
      this.pendingNotes.delete(id);
      this.liveIds.delete(id);
      this.finishRecordingNote(id);
      this.finalizeRetro(id);
      return;
    }
    const index = this.liveIds.get(id);
    if (index !== undefined) {
      engine.noteOff(index, id);
      this.liveIds.delete(id);
    }
    this.finishRecordingNote(id);
    this.finalizeRetro(id);
  }

  private finalizeRetro(id: string): void {
    const ev = this.retroActive.get(id);
    if (!ev) return;
    const nowBeat = this.scheduler.isPlaying ? this.scheduler.currentBeat() : this.playhead;
    ev.length = Math.max(0.0625, nowBeat - ev.start);
    pushRetro(this.retroBuffer, ev);
    this.retroActive.delete(id);
  }

  private flushRetroActive(): void {
    if (!this.retroActive.size) return;
    const nowBeat = this.scheduler.isPlaying ? this.scheduler.currentBeat() : this.playhead;
    for (const [id, ev] of this.retroActive) {
      ev.length = Math.max(0.0625, nowBeat - ev.start);
      pushRetro(this.retroBuffer, ev);
    }
    this.retroActive.clear();
  }

  private finishRecordingNote(id: string): void {
    const rec = this.recNotes.get(id);
    if (!rec) return;
    const beat = this.scheduler.isPlaying ? this.scheduler.currentBeat() : this.playhead;
    rec.note.length = Math.max(0.0625, beat - rec.absStart);
    this.recNotes.delete(id);
    this.commit('录制音符');
  }

  applyPreset(presetId: string): boolean {
    const track = this.getSelectedTrack();
    const preset = presetById(presetId);
    if (!track || !preset) return false;
    if (track.kind === 'audio') {
      this.notify('音频轨不能应用音色；请先选择一条乐器轨', 'warn');
      return false;
    }
    track.instrument = {
      presetId: preset.id,
      type: preset.type,
      params: mergeParams(preset.type, preset.params),
    };
    // 预设里的合唱/过载属于轨道级效果，应用时必须同步，否则音色描述与实际听感不符
    if (preset.fx) {
      // 自定义音色保存了完整效果快照（音量/声像/发送/低通/过载/合唱）
      const fx = preset.fx;
      if (typeof fx.volume === 'number') track.volume = clamp(fx.volume, 0, 1);
      if (typeof fx.pan === 'number') track.pan = clamp(fx.pan, -1, 1);
      if (typeof fx.sendReverb === 'number') track.sendReverb = clamp(fx.sendReverb, 0, 1);
      if (typeof fx.sendDelay === 'number') track.sendDelay = clamp(fx.sendDelay, 0, 1);
      if (typeof fx.tone === 'number') track.tone = clamp(fx.tone, 0.1, 1);
      if (typeof fx.drive === 'number') track.drive = clamp(fx.drive, 0, 1);
      if (typeof fx.chorus === 'number') track.chorus = clamp(fx.chorus, 0, 1);
    } else {
      const fx = presetTrackFx(preset.type, preset.params);
      track.drive = fx.drive;
      track.chorus = fx.chorus;
    }
    const index = this.project.tracks.indexOf(track);
    if (engine.ready) engine.syncTrack(track, index);
    this.keyboard.rebuild();
    this.commit(`应用音色「${preset.name}」`);
    return true;
  }

  auditionPreset(presetId: string): void {
    const preset = presetById(presetId);
    if (!preset) return;
    void (async () => {
      try {
        await engine.ensure();
        this.updateEngineInfo();
        engine.syncProject(this.project);
        await engine.previewNotes(
          auditionNotes(preset.type, auditionMinLength(preset.params.attack ?? 0)),
          96,
          preset.type,
          mergeParams(preset.type, preset.params),
          'normal',
          this.presetAuditionFx(preset),
        );
        this.notify(`试听「${preset.name}」 · ${preset.description}`);
      } catch (err) {
        this.notify(`音频引擎启动失败：${String(err)}`, 'error');
      }
    })();
  }

  /** A/B 对比：同一条试听乐句，先候选音色，再当前轨道音色 */
  auditionPair(presetId: string): void {
    const preset = presetById(presetId);
    if (!preset) return;
    const track = this.getSelectedTrack();
    const current = track ? presetById(track.instrument.presetId) : undefined;
    if (!current || current.id === preset.id) {
      this.auditionPreset(presetId);
      return;
    }
    void (async () => {
      try {
        await engine.ensure();
        this.updateEngineInfo();
        engine.syncProject(this.project);
        // A/B 使用同一最小长度，保证两段试听在相同节奏下对比
        const hold = auditionMinLength(Math.max(preset.params.attack ?? 0, current.params.attack ?? 0));
        const notesA = auditionNotes(preset.type, hold);
        const notesB = auditionNotes(current.type, hold);
        const beats = Math.max(
          ...notesA.map((n) => n.start + n.length),
          ...notesB.map((n) => n.start + n.length),
        );
        this.notify(`A/B 对比：A「${preset.name}」`);
        await engine.previewNotes(
          notesA, 96, preset.type, mergeParams(preset.type, preset.params), 'normal', this.presetAuditionFx(preset),
        );
        await new Promise((resolve) => window.setTimeout(resolve, (beatsToSeconds(beats, 96) + 0.7) * 1000));
        this.notify(`A/B 对比：B 当前「${current.name}」`);
        await engine.previewNotes(
          notesB, 96, current.type, mergeParams(current.type, current.params), 'normal', this.presetAuditionFx(current),
        );
      } catch (err) {
        this.notify(`音频引擎启动失败：${String(err)}`, 'error');
      }
    })();
  }

  saveTrackAsPreset(name: string): boolean {
    const track = this.getSelectedTrack();
    const clean = name.trim().slice(0, 40);
    if (!track || !clean) {
      this.notify('请先选择一条轨道并输入音色名称', 'warn');
      return false;
    }
    const base = presetById(track.instrument.presetId) || defaultPresetForType(track.instrument.type);
    const fx: PresetFx = {
      volume: clamp(track.volume, 0, 1),
      pan: clamp(track.pan, -1, 1),
      sendReverb: clamp(track.sendReverb, 0, 1),
      sendDelay: clamp(track.sendDelay, 0, 1),
      tone: clamp(track.tone, 0.1, 1),
      drive: clamp(track.drive, 0, 1),
      chorus: clamp(track.chorus, 0, 1),
    };
    const preset: Preset = {
      id: `user-${uid('p')}`,
      name: clean,
      category: '我的音色',
      type: track.instrument.type,
      description: `自定义音色 · 基于「${base.name}」`,
      tags: ['自定义', base.name],
      params: { ...track.instrument.params },
      macros: base.macros.map((m) => ({ ...m, targets: m.targets.map((t) => ({ ...t })) })),
      usage: base.usage,
      fx,
      custom: true,
    };
    addUserPreset(preset);
    // 保存后让当前轨道引用新音色，检查器与浏览器马上能看到它是“当前音色”
    track.instrument.presetId = preset.id;
    const index = this.project.tracks.indexOf(track);
    if (engine.ready) engine.syncTrack(track, index);
    this.commit(`已保存音色「${preset.name}」`);
    return true;
  }

  removeUserPreset(id: string): void {
    removePresetEntry(id);
    for (const track of this.project.tracks) {
      if (track.instrument.presetId !== id) continue;
      // 音色库条目删除后轨道回到该类型的默认音色，参数与效果保留
      track.instrument.presetId = defaultPresetForType(track.instrument.type).id;
      const index = this.project.tracks.indexOf(track);
      if (engine.ready) engine.syncTrack(track, index);
    }
    this.commit('删除自定义音色');
  }

  saveClipAsBlock(name: string): boolean {
    const clip = this.getSelectedClip();
    const track = clip ? findTrack(this.project, clip.trackId) : undefined;
    if (!clip || !track) {
      this.notify('请先在时间轴上选择一个片段', 'warn');
      return false;
    }
    const notes = clip.notes
      .filter((n) => n.start >= clip.offset && n.start < clip.offset + clip.length)
      .map((n) => ({ ...n, pitch: n.pitch + clip.transpose, start: n.start - clip.offset }));
    const block = blockFromClipNotes(name, notes, track.instrument.type, clip.length);
    if (!block) {
      this.notify('片段里没有可保存的音符', 'warn');
      return false;
    }
    addUserBlock(block);
    this.browser.render();
    this.notify(`已保存编曲块「${block.name}」· ${block.bars} 小节`);
    return true;
  }

  removeUserBlock(id: string): void {
    removeBlockEntry(id);
    this.refresh();
    this.notify('删除自定义编曲块');
  }

  getSelectedNotes(): Note[] {
    return this.pianoroll?.getSelectedNotes() ?? [];
  }

  setNoteVelocity(velocity: number): void {
    this.pianoroll?.setVelocity(velocity);
  }

  refreshInspector(): void {
    this.inspector?.render();
  }

  loadDemo(demoId: string): void {
    const p = demoById(demoId);
    if (!p) return;
    this.adoptProject(normalizeProject(p), `已载入示例「${p.name}」`);
  }

  ambientGenerate(presetId: string, options: { seed?: string; durationSec?: number; tempo?: number } = {}): void {
    const seed = options.seed?.trim() || String(Math.floor(Math.random() * 1e9));
    const result = generateAmbientPiece({ presetId, seed, durationSec: options.durationSec, tempo: options.tempo });
    const stats = result.stats;
    this.adoptProject(
      normalizeProject(result.project),
      `已生成「${result.project.name}」· ${stats.trackCount} 轨 · ${stats.eventCount} 音符 · ${Math.round(stats.totalSeconds)} 秒`,
    );
  }

  updateParams(patch: Record<string, number>, commitLabel?: string): void {
    const track = this.getSelectedTrack();
    if (!track) return;
    Object.assign(track.instrument.params, patch);
    const index = this.project.tracks.indexOf(track);
    if (engine.ready) engine.syncTrack(track, index);
    if (commitLabel) this.commit(commitLabel);
    else this.queueSave();
  }

  setTrackFx(field: TrackFxField, value: number, commitLabel?: string): void {
    const track = this.getSelectedTrack();
    if (!track) return;
    (track as unknown as Record<string, number>)[field] = value;
    const index = this.project.tracks.indexOf(track);
    if (engine.ready) engine.syncTrack(track, index);
    if (commitLabel) this.commit(commitLabel);
    else this.queueSave();
  }

  isAutomationArmed(): boolean { return this.automationArmed; }
  setAutomationArmed(on: boolean): void { this.automationArmed = on; }

  removeAutomationLane(paramId: string): void {
    const track = this.getSelectedTrack();
    if (!track) return;
    track.automation = track.automation.filter((l) => l.paramId !== paramId);
    this.commit('删除自动化');
  }

  deleteTrack(id: string): void {
    if (this.project.tracks.length <= 1) return;
    const index = this.project.tracks.findIndex((t) => t.id === id);
    if (index < 0) return;
    this.project.tracks.splice(index, 1);
    this.project.clips = this.project.clips.filter((c) => c.trackId !== id);
    if (this.selectedTrackId === id) {
      const next = this.project.tracks[Math.min(index, this.project.tracks.length - 1)];
      this.selectedTrackId = next ? next.id : null;
    }
    if (this.selectedClipId && !findClip(this.project, this.selectedClipId)) this.selectedClipId = null;
    this.syncAudio();
    this.keyboard.rebuild();
    this.commit('删除轨道');
  }

  renameTrack(id: string, name: string): void {
    const track = this.project.tracks.find((t) => t.id === id);
    if (!track) return;
    track.name = name.slice(0, 24);
    this.commit('重命名轨道');
  }

  // ---------------- audio ----------------
  private async ensureAudio(): Promise<void> {
    try {
      await engine.ensure();
      this.updateEngineInfo();
      this.syncAudio();
    } catch (err) {
      this.notify(`音频引擎启动失败：${String(err)}`, 'error');
      throw err;
    }
  }

  private syncAudio(): void {
    if (!engine.ready) return;
    this.syncAssets();
    engine.syncProject(this.project);
    for (let i = this.project.tracks.length; i < MAX_TRACKS; i++) {
      engine.post({ type: 'track', track: i, mute: true });
    }
  }

  /** 把带 PCM 的素材发送给 Worklet；同一素材只发送一次 */
  private syncAssets(): void {
    if (!engine.ready) return;
    for (const asset of this.project.audioAssets || []) {
      if (!asset.data || this.registeredAssets.has(asset.id)) continue;
      if (engine.registerAsset(asset)) this.registeredAssets.add(asset.id);
    }
  }

  /** 被音频片段引用但缺少 PCM 的素材数量（自动保存剥离或素材未随工程载入） */
  private missingAssetCount(): number {
    const assets = this.project.audioAssets || [];
    const used = new Set<string>();
    for (const clip of this.project.clips) {
      if (clip.audio) used.add(clip.audio.assetId);
    }
    let missing = 0;
    for (const id of used) {
      const asset = assets.find((a) => a.id === id);
      if (!asset || !asset.data) missing++;
    }
    return missing;
  }

  private updateEngineInfo(): void {
    const el = $('engine-info');
    if (!el) return;
    if (!engine.ready) {
      el.textContent = '音频引擎未启动 · Web Audio / AudioWorklet';
      return;
    }
    const st = engine.ctx?.state === 'running' ? '运行中' : engine.ctx?.state || '未知';
    el.textContent = `${Math.round(engine.sampleRate / 1000)} kHz · ${st} · AudioWorklet`;
  }

  private async initMidi(): Promise<void> {
    if (!this.midi) {
      this.midi = new MidiInput({
        noteOn: (pitch, velocity) => {
          if (this.midiHeld.has(pitch)) return;
          this.midiHeld.set(pitch, this.liveNoteOn(pitch, velocity));
        },
        noteOff: (pitch) => {
          const id = this.midiHeld.get(pitch);
          this.midiHeld.delete(pitch);
          if (id) this.liveNoteOff(id);
        },
        bend: (value) => this.midiBend(value),
        pressure: (value) => this.midiPressure(value),
        control: (cc, value) => this.midiControl(cc, value),
        status: (text, connected) => this.setMidiInfo(text, connected),
      });
    }
    if (this.midi.enabled) {
      this.midi.refresh();
      this.notify('已刷新 MIDI 设备列表');
      return;
    }
    if (await this.midi.enable()) {
      this.notify('MIDI 已启用 · 用设备演奏当前选中轨道；踏板、弯音、触后与 CC 映射同样生效');
    }
  }

  private selectedTrackIndex(): number {
    const track = this.getSelectedTrack();
    if (!track) return -1;
    return this.project.tracks.indexOf(track);
  }

  private midiBend(value: number): void {
    const index = this.selectedTrackIndex();
    if (index < 0 || !engine.ready) return;
    engine.bend(index, clamp(value, -1, 1) * 2);
  }

  private midiPressure(value: number): void {
    const index = this.selectedTrackIndex();
    if (index < 0 || !engine.ready) return;
    engine.pressure(index, clamp(value, 0, 1));
  }

  /** CC 优先交给 MIDI Learn；未处于学习状态时按已有映射应用到当前轨道 */
  private midiControl(cc: number, raw: number): void {
    const track = this.getSelectedTrack();
    if (!track) return;
    if (this.midiLearn) {
      const target = this.midiLearn;
      const range = targetRange(track, target);
      if (!range) {
        this.notify('该参数不适用于当前音源，未建立映射', 'warn');
        return;
      }
      this.midiMappings = upsertMapping(this.midiMappings, {
        cc, kind: target.kind, key: target.key, min: range.min, max: range.max,
      });
      saveMidiMappings(this.midiMappings);
      this.midiLearn = null;
      this.notify(`MIDI Learn：CC${cc} → ${targetLabel(track, target)}`);
      this.refreshInspector();
      return;
    }
    const mapping = mappingFor(this.midiMappings, cc);
    if (!mapping || !targetRange(track, mapping)) return;
    const value = applyMidiRaw(mapping, raw);
    if (mapping.kind === 'param') {
      this.updateParams({ [mapping.key]: value });
      this.recordAutomation(`param:${mapping.key}`, value);
    } else {
      this.setTrackFx(mapping.key as TrackFxField, value);
      this.recordAutomation(`fx:${mapping.key}`, value);
    }
  }

  beginMidiLearn(kind: MidiLearnKind, key: string): void {
    const track = this.getSelectedTrack();
    if (!track) {
      this.notify('请先选择一条轨道再开始 MIDI Learn', 'warn');
      return;
    }
    this.midiLearn = { kind, key };
    this.notify(`MIDI Learn：移动控制器以绑定「${targetLabel(track, this.midiLearn)}」`);
    this.refreshInspector();
  }

  cancelMidiLearn(): void {
    if (!this.midiLearn) return;
    this.midiLearn = null;
    this.notify('已取消 MIDI Learn');
    this.refreshInspector();
  }

  getMidiLearnTarget(): MidiLearnTarget | null {
    return this.midiLearn;
  }

  getMidiMappings(): MidiMapping[] {
    return this.midiMappings;
  }

  removeMidiMapping(cc: number): void {
    this.midiMappings = removeMapping(this.midiMappings, cc);
    saveMidiMappings(this.midiMappings);
    this.notify(`已删除 CC${cc} 映射`);
    this.refreshInspector();
  }

  private setMidiInfo(text: string, connected: boolean): void {
    const el = $('midi-info');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('on', connected);
  }

  private async togglePlay(): Promise<void> {
    if (this.scheduler.isPlaying) {
      this.stopPlayback();
      return;
    }
    try {
      await this.ensureAudio();
    } catch {
      return;
    }
    const loop = this.project.loop;
    let from = this.playhead;
    if (loop.enabled && (from < loop.start || from >= loop.end)) from = loop.start;
    this.playhead = from;
    this.scheduler.setMetronome(this.metronome);
    await this.scheduler.play(from);
    this.updateTransport();
    this.sendPositionToViews();
    this.notify('播放中 · 音频时钟驱动');
  }

  private stopPlayback(): void {
    this.scheduler.stop();
    // 停止只取消运输事件；实时键盘声部在这里显式释放，不触发全局 allNotesOff
    this.midi?.releaseAll();
    this.midiHeld.clear();
    for (const [id, index] of this.liveIds) engine.noteOff(index, id);
    this.playhead = this.scheduler.position;
    this.recording = false;
    this.pendingNotes.clear();
    this.liveIds.clear();
    this.recNotes.clear();
    this.flushRetroActive();
    this.needsDraw = true;
    this.updateTransport();
    this.updatePositionLabel();
    this.sendPositionToViews();
    this.notify('已停止');
  }

  private sendPositionToViews(): void {
    this.timeline.render();
    this.pianoroll.render();
  }

  private toggleRecord(): void {
    if (!this.recording) {
      this.ensureRecordingClip();
      this.recording = true;
      if (!this.scheduler.isPlaying) void this.togglePlay();
      this.notify('录制中 · 在钢琴卷帘或键盘上演奏即可写入音符');
    } else {
      this.recording = false;
      this.notify('已结束录制');
    }
    this.updateTransport();
    this.refresh();
  }

  private ensureRecordingClip(): void {
    const track = this.getSelectedTrack();
    if (!track) return;
    const loop = this.project.loop;
    const start = loop.enabled ? loop.start : Math.max(0, Math.floor(this.playhead));
    const length = loop.enabled ? Math.max(1, loop.end - loop.start) : 8;
    const existing = this.getSelectedClip();
    if (existing && existing.trackId === track.id) return;
    const clip = createClip(track.id, start, length, '录制片段');
    this.project.clips.push(clip);
    this.selectedClipId = clip.id;
  }

  /** 回溯录制：把未录音时弹过的音符写回当前选中片段 */
  private restoreRetro(): void {
    this.flushRetroActive();
    const track = this.getSelectedTrack();
    if (!track || track.kind === 'audio') {
      this.notify('请先选择一条乐器轨', 'warn');
      return;
    }
    if (!this.retroBuffer.length) {
      this.notify('回溯缓冲为空：先在未录音时演奏一些音符', 'warn');
      return;
    }
    let clip = this.getSelectedClip();
    if (!clip || clip.trackId !== track.id) {
      this.ensureRecordingClip();
      clip = this.getSelectedClip();
    }
    if (!clip) return;
    const idGen = () => `n_${Math.random().toString(36).slice(2, 8)}`;
    const notes = retroToNotes(this.retroBuffer, clip.start, clip.offset, clip.length, this.snap, idGen);
    if (!notes.length) {
      this.notify('回溯缓冲中的音符不在所选片段范围内，未写入', 'warn');
      return;
    }
    clip.notes.push(...notes);
    this.retroBuffer = [];
    this.commit(`回溯录制 ${notes.length} 个音符`);
  }

  // ---------------- project lifecycle ----------------
  private adoptProject(p: Project, message: string): void {
    this.scheduler.stop();
    engine.allNotesOff();
    this.project = normalizeProject(p);
    this.history.reset(this.project);
    if (!findTrack(this.project, this.selectedTrackId)) {
      this.selectedTrackId = this.project.tracks[0]?.id ?? null;
    }
    if (!findClip(this.project, this.selectedClipId)) this.selectedClipId = null;
    this.playhead = 0;
    this.scheduler.seek(0);
    this.syncAudio();
    this.keyboard?.rebuild();
    this.saveLocal();
    this.refresh();
    const missing = this.missingAssetCount();
    if (missing) this.notify(`${message} · ${missing} 个音频素材缺少 PCM，请重新导入对应 WAV`, 'warn');
    else this.notify(message);
  }

  private undo(): void {
    const p = this.history.undo();
    if (!p) {
      this.notify('没有可撤销的操作', 'warn');
      return;
    }
    this.project = normalizeProject(p);
    if (!findTrack(this.project, this.selectedTrackId)) {
      this.selectedTrackId = this.project.tracks[0]?.id ?? null;
    }
    if (!findClip(this.project, this.selectedClipId)) this.selectedClipId = null;
    this.scheduler.seek(this.playhead);
    this.syncAudio();
    this.keyboard?.rebuild();
    this.saveLocal();
    this.refresh();
    this.notify('已撤销');
  }

  private redo(): void {
    const p = this.history.redo();
    if (!p) {
      this.notify('没有可重做的操作', 'warn');
      return;
    }
    this.project = normalizeProject(p);
    if (!findTrack(this.project, this.selectedTrackId)) {
      this.selectedTrackId = this.project.tracks[0]?.id ?? null;
    }
    if (!findClip(this.project, this.selectedClipId)) this.selectedClipId = null;
    this.scheduler.seek(this.playhead);
    this.syncAudio();
    this.keyboard?.rebuild();
    this.saveLocal();
    this.refresh();
    this.notify('已重做');
  }

  private newProject(): void {
    if (!window.confirm('新建工程会丢弃当前未保存的修改，继续？')) return;
    this.adoptProject(normalizeProject(createEmptyProject()), '已新建工程');
    this.saveLocal();
  }

  private saveLocal(): void {
    try {
      // 自动保存剔除 PCM（体积可达数十 MB，会撑爆 localStorage）；手动保存仍内嵌素材
      const snapshot = { ...this.project, audioAssets: stripAssetData(this.project.audioAssets || []) };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
    } catch {
      /* 存储不可用或超限时忽略，手动保存仍可使用 */
    }
  }

  private queueSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.saveLocal();
    }, 600);
  }

  // ---------------- files ----------------
  private bindFiles(): void {
    const openInput = $<HTMLInputElement>('file-open');
    $('btn-open').onclick = () => {
      openInput.value = '';
      openInput.click();
    };
    openInput.onchange = () => {
      const file = openInput.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        try {
          const p = parseProject(text);
          this.adoptProject(normalizeProject(p), `已打开「${p.name}」`);
          this.saveLocal();
        } catch (err) {
          this.notify(`打开失败：${String(err)}`, 'error');
        }
      });
    };

    $('btn-save').onclick = () => {
      const name = `${safeFileName(this.project.name)}.swproj.json`;
      const blob = new Blob([serializeProject(this.project)], { type: 'application/json' });
      downloadBlob(blob, name);
      this.saveLocal();
      this.notify(`已保存工程文件：${name}`);
    };

    const midiInput = $<HTMLInputElement>('file-midi');
    $('btn-midi-import').onclick = () => {
      midiInput.value = '';
      midiInput.click();
    };
    midiInput.onchange = () => {
      const file = midiInput.files?.[0];
      if (!file) return;
      void file.arrayBuffer().then((buf) => {
        try {
          this.importMidi(buf);
        } catch (err) {
          this.notify(`MIDI 导入失败：${String(err)}`, 'error');
        }
      });
    };

    $('btn-midi-export').onclick = () => {
      const buffer = writeMidi(this.project);
      const name = `${safeFileName(this.project.name)}.mid`;
      downloadBlob(new Blob([buffer], { type: 'audio/midi' }), name);
      this.notify(`已导出 MIDI：${name}`);
    };

    const wavInput = $<HTMLInputElement>('file-audio');
    $('btn-wav-import').onclick = () => {
      wavInput.value = '';
      wavInput.click();
    };
    wavInput.onchange = () => {
      const file = wavInput.files?.[0];
      if (file) void this.importWav(file).catch((err) => this.notify(`WAV 导入失败：${String(err)}`, 'error'));
    };

    $('btn-wav-export').onclick = () => void this.exportMixdown();
    const stemsBtn = document.getElementById('btn-stems-export');
    if (stemsBtn) stemsBtn.onclick = () => void this.exportStems();
  }

  private importMidi(buffer: ArrayBuffer): void {
    const midi = parseMidi(buffer);
    if (!midi.tracks.length) {
      this.notify('MIDI 文件里没有可导入的音符', 'warn');
      return;
    }
    if (Number.isFinite(midi.tempo) && midi.tempo > 0) {
      this.project.tempo = clamp(midi.tempo, 30, 240);
    }
    let added = 0;
    for (const mt of midi.tracks) {
      if (this.project.tracks.length >= MAX_TRACKS) break;
      const type = guessTypeFromProgram(mt.program, mt.channel);
      const preset = defaultPresetForType(type);
      const track = createTrack(
        this.project.tracks.length,
        { presetId: preset.id, type, params: mergeParams(type, preset.params) },
        mt.name || `MIDI ${this.project.tracks.length + 1}`,
      );
      const end = mt.notes.reduce((m, n) => Math.max(m, n.start + n.length), 0);
      const clip = createClip(track.id, 0, Math.max(4, Math.ceil(end / 4) * 4), mt.name || 'MIDI 片段');
      clip.notes = mt.notes.map((n) => ({
        id: uid('n'),
        pitch: n.pitch,
        start: n.start,
        length: Math.max(0.05, n.length),
        velocity: clamp(n.velocity, 0.05, 1),
        articulation: 'normal' as const,
      }));
      this.project.tracks.push(track);
      this.project.clips.push(clip);
      if (!this.selectedClipId) this.selectedClipId = clip.id;
      added++;
    }
    this.syncAudio();
    this.keyboard.rebuild();
    this.commit(`导入 MIDI 完成：${added} 条轨道`);
  }

  /** 导入 WAV 的入口：串行化，避免并发重入 */
  private async importWav(file: File): Promise<void> {
    if (this.importingWav) return;
    this.importingWav = true;
    try {
      await this.importWavInner(file);
    } finally {
      this.importingWav = false;
    }
  }

  /** 解码 → 素材入库 → 复用/新建音频轨 → 在播放头处放置片段 */
  private async importWavInner(file: File): Promise<void> {
    if (file.size > 64 * 1024 * 1024) {
      this.notify('WAV 文件超过 64 MB，未导入', 'warn');
      return;
    }
    let decoded;
    try {
      decoded = decodeWav(await file.arrayBuffer());
    } catch (err) {
      this.notify(`WAV 导入失败：${String(err)}`, 'error');
      return;
    }
    if (decoded.channels.length > 2) {
      this.notify('暂只支持单声道/双声道 WAV', 'warn');
      return;
    }
    if (decoded.duration > MAX_ASSET_SECONDS) {
      this.notify(`单个音频素材最长 ${MAX_ASSET_SECONDS} 秒`, 'warn');
      return;
    }
    const asset = createAudioAsset(file.name, decoded.sampleRate, decoded.channels);
    const assets = (this.project.audioAssets ||= []);
    const adopted = adoptAudioAsset(assets, asset);
    const now = performance.now();
    // 同一次选择文件的操作偶尔会被浏览器连派两次 change：两秒内重复导入同一素材直接忽略
    if (adopted.mode === 'existing' && this.lastImport?.assetId === adopted.asset.id && now - this.lastImport.at < 2000) {
      return;
    }
    // restore / rebind 表示这次导入是在补回自动保存剥离的 PCM：只恢复素材，不额外摆放片段
    if (adopted.mode === 'restore' || adopted.mode === 'rebind') {
      const ref = this.project.clips.find((c) => c.audio?.assetId === adopted.asset.id);
      if (ref) {
        this.selectedTrackId = ref.trackId;
        this.selectedClipId = ref.id;
      }
      this.registeredAssets.delete(adopted.asset.id);
      this.keyboard.rebuild();
      this.syncAudio();
      this.lastImport = { assetId: adopted.asset.id, at: now };
      this.commit(`已恢复音频素材「${file.name}」 · ${adopted.asset.duration.toFixed(2)} 秒`);
      return;
    }

    const track = this.findOrCreateAudioTrack();
    if (!track) {
      this.notify(`轨道已满（上限 ${MAX_TRACKS} 条），请先删除一条轨道`, 'warn');
      return;
    }
    const beatLength = Math.max(0.25, (adopted.asset.duration * this.project.tempo) / 60);
    const snap = this.snap;
    let start = Math.max(0, Math.round(this.playhead / snap) * snap);
    const overlaps = this.project.clips.some(
      (c) => c.trackId === track.id && start < c.start + c.length && start + beatLength > c.start,
    );
    if (overlaps) start = nextClipStart(this.project, track.id);
    const clip = createAudioClip(track.id, start, beatLength, adopted.asset.id, file.name);
    this.project.clips.push(clip);
    this.selectedTrackId = track.id;
    this.selectedClipId = clip.id;
    this.registeredAssets.delete(adopted.asset.id);
    this.keyboard.rebuild();
    this.syncAudio();
    this.lastImport = { assetId: adopted.asset.id, at: now };
    this.commit(`已导入音频「${file.name}」 · ${adopted.asset.duration.toFixed(2)} 秒`);
  }

  /** 优先复用已有音频轨；没有则新建一条（轨道数受 15 条上限约束） */
  private findOrCreateAudioTrack(): Track | null {
    const existing = this.project.tracks.find((t) => t.kind === 'audio');
    if (existing) return existing;
    if (this.project.tracks.length >= MAX_TRACKS) return null;
    const preset = defaultPresetForType('synth');
    const track = createTrack(
      this.project.tracks.length,
      { presetId: preset.id, type: 'synth', params: mergeParams('synth', preset.params) },
      `音频 ${this.project.tracks.filter((t) => t.kind === 'audio').length + 1}`,
      'audio',
    );
    track.volume = 0.8;
    track.sendReverb = 0;
    this.project.tracks.push(track);
    return track;
  }

  private async exportMixdown(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setBusy(true, '离线渲染混音…');
    this.notify('正在离线渲染混音 WAV…');
    try {
      const buffer = await engine.renderOffline(this.project);
      const channels: Float32Array[] = [buffer.getChannelData(0)];
      if (buffer.numberOfChannels > 1) channels.push(buffer.getChannelData(1));
      const wav = encodeWav(channels, buffer.sampleRate);
      const name = `${safeFileName(this.project.name)}.wav`;
      downloadBlob(new Blob([wav], { type: 'audio/wav' }), name);
      this.notify(`已导出 WAV：${buffer.duration.toFixed(2)} 秒 · ${buffer.sampleRate} Hz · 16-bit`);
    } catch (err) {
      this.notify(`WAV 导出失败：${String(err)}`, 'error');
    } finally {
      this.busy = false;
      this.setBusy(false);
    }
  }

  private async exportStems(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setBusy(true, '离线渲染分轨…');
    this.notify('正在离线渲染分轨…');
    try {
      const stems = await engine.renderStems(this.project, (done, total) => {
        this.notify(`分轨渲染 ${done}/${total}…`);
      });
      const base = safeFileName(this.project.name);
      stems.forEach((stem, i) => {
        const channels: Float32Array[] = [stem.buffer.getChannelData(0)];
        if (stem.buffer.numberOfChannels > 1) channels.push(stem.buffer.getChannelData(1));
        const wav = encodeWav(channels, stem.buffer.sampleRate);
        downloadBlob(
          new Blob([wav], { type: 'audio/wav' }),
          `${base}-${String(i + 1).padStart(2, '0')}-${safeFileName(stem.track.name)}.wav`,
        );
      });
      this.notify(`已导出 ${stems.length} 条分轨 WAV`);
    } catch (err) {
      this.notify(`分轨导出失败：${String(err)}`, 'error');
    } finally {
      this.busy = false;
      this.setBusy(false);
    }
  }

  // ---------------- UI wiring ----------------
  private bindTransport(): void {
    $('btn-play').onclick = () => void this.togglePlay();
    $('btn-stop').onclick = () => this.stopPlayback();
    $('btn-record').onclick = () => this.toggleRecord();
    $('btn-retro').onclick = () => this.restoreRetro();
    $('btn-view-roll').onclick = () => this.setEditorView('roll');
    $('btn-view-staff').onclick = () => this.setEditorView('staff');
    $('btn-metro').onclick = () => {
      this.metronome = !this.metronome;
      this.scheduler.setMetronome(this.metronome);
      this.updateTransport();
    };
    $('btn-new').onclick = () => this.newProject();
    $('btn-undo').onclick = () => this.undo();
    $('btn-redo').onclick = () => this.redo();
    $('btn-zoom-out').onclick = () => {
      this.timeline.zoomBy(1 / 1.2);
      this.needsDraw = true;
    };
    $('btn-zoom-in').onclick = () => {
      this.timeline.zoomBy(1.2);
      this.needsDraw = true;
    };

    const bpm = $<HTMLInputElement>('bpm');
    bpm.onchange = () => {
      const v = clamp(Number(bpm.value) || this.project.tempo, 30, 240);
      // setTempo 先用旧速度捕获当前位置，再以新速度重锚并取消旧事件
      this.scheduler.setTempo(v);
      this.commit(`速度 ${v} BPM`);
    };

    const loopEnabled = $<HTMLInputElement>('loop-enabled');
    loopEnabled.onchange = () => {
      this.project.loop.enabled = loopEnabled.checked;
      this.scheduler.reanchor();
      this.commit(loopEnabled.checked ? '开启循环' : '关闭循环');
    };

    const loopStart = $<HTMLInputElement>('loop-start');
    const loopEnd = $<HTMLInputElement>('loop-end');
    const applyLoop = () => {
      let s = Math.max(0, Number(loopStart.value) || 0);
      let e = Math.max(s + 1, Number(loopEnd.value) || s + 1);
      s = Math.floor(s);
      e = Math.floor(e);
      this.project.loop.start = s;
      this.project.loop.end = e;
      this.scheduler.reanchor();
      this.commit('调整循环区间');
    };
    loopStart.onchange = applyLoop;
    loopEnd.onchange = applyLoop;

    const snap = $<HTMLSelectElement>('snap');
    snap.onchange = () => {
      this.snap = Number(snap.value) || 0.25;
      this.notify(`吸附已设为 ${snap.options[snap.selectedIndex].text}`);
      this.needsDraw = true;
    };
  }

  private bindShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo();
          else this.undo();
          return;
        }
        if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          this.redo();
          return;
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          $('btn-save').click();
          return;
        }
        if (e.key.toLowerCase() === 'c') {
          const n = this.pianoroll.copySelected();
          if (n) {
            e.preventDefault();
            this.notify(`已复制 ${n} 个音符`);
          }
          return;
        }
        if (e.key.toLowerCase() === 'v') {
          if (this.pianoroll.paste()) e.preventDefault();
          return;
        }
        if (e.key.toLowerCase() === 'a') {
          const n = this.pianoroll.selectAll();
          if (n) {
            e.preventDefault();
            this.notify(`已选中 ${n} 个音符`);
          }
          return;
        }
        return;
      }
      if (e.key === '?' || e.key === 'F1') {
        e.preventDefault();
        this.toggleHelp();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        void this.togglePlay();
        return;
      }
      if (e.key === 'Escape') {
        if (this.helpOpen) {
          e.preventDefault();
          this.closeHelp();
        } else {
          this.stopPlayback();
        }
        return;
      }
      if (e.key.startsWith('Arrow') && this.pianoroll.hasSelection()) {
        e.preventDefault();
        const snap = this.snap;
        const dBeat = e.key === 'ArrowLeft' ? -snap : e.key === 'ArrowRight' ? snap : 0;
        const dPitch = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
        this.pianoroll.nudgeSelected(dBeat, dPitch);
        this.commit('微调音符');
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.pianoroll.hasSelection() && this.pianoroll.deleteSelected()) {
          e.preventDefault();
          return;
        }
        if (this.selectedClipId) {
          e.preventDefault();
          this.deleteSelectedClip();
          return;
        }
      }
    });
  }

  private deleteSelectedClip(): void {
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.project.clips = this.project.clips.filter((c) => c.id !== clip.id);
    this.selectedClipId = null;
    this.commit('删除片段');
  }

  // ---------------- 布局与帮助 ----------------
  private bindResizers(): void {
    const KEY = 'soundweave.layout.v1';
    let saved: Partial<{ colLeft: number; colRight: number; keyboardH: number }> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      saved = {};
    }
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const state = {
      colLeft: num(saved.colLeft, 286),
      colRight: num(saved.colRight, 356),
      keyboardH: num(saved.keyboardH, 168),
    };
    const app = $('app');
    const ws = document.querySelector<HTMLElement>('.workspace');
    if (!app || !ws) return;

    const apply = (): void => {
      const w = window.innerWidth || 1280;
      state.colLeft = clamp(state.colLeft, 190, Math.min(520, w * 0.42));
      state.colRight = clamp(state.colRight, 260, Math.min(620, w * 0.5));
      state.keyboardH = clamp(state.keyboardH, 100, 340);
      app.style.setProperty('--keyboard-h', `${state.keyboardH}px`);
      ws.style.setProperty('--col-left', `${state.colLeft}px`);
      ws.style.setProperty('--col-right', `${state.colRight}px`);
    };
    apply();
    const persist = (): void => {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        /* 存储不可用时忽略 */
      }
    };

    this.makeResizer($('resizer-left'), state, 'colLeft', 'x', 1, apply, persist);
    this.makeResizer($('resizer-right'), state, 'colRight', 'x', -1, apply, persist);
    this.makeResizer($('resizer-keyboard'), state, 'keyboardH', 'y', -1, apply, persist);
  }

  private makeResizer(
    el: HTMLElement,
    state: { colLeft: number; colRight: number; keyboardH: number },
    key: 'colLeft' | 'colRight' | 'keyboardH',
    axis: 'x' | 'y',
    dir: 1 | -1,
    apply: () => void,
    persist: () => void,
  ): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const start = axis === 'x' ? e.clientX : e.clientY;
      const base = state[key];
      const onMove = (ev: PointerEvent): void => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
        state[key] = base + delta * dir;
        apply();
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing');
        persist();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    // 键盘可访问：聚焦到分隔条后可用方向键微调
    el.addEventListener('keydown', (ev) => {
      const step = 8;
      let delta = 0;
      if (axis === 'x') {
        delta = ev.key === 'ArrowRight' ? step * dir : ev.key === 'ArrowLeft' ? -step * dir : 0;
      } else {
        delta = ev.key === 'ArrowDown' ? step * dir : ev.key === 'ArrowUp' ? -step * dir : 0;
      }
      if (delta) {
        ev.preventDefault();
        ev.stopPropagation();
        state[key] = state[key] + delta;
        apply();
        persist();
      }
    });
  }

  private bindHelp(): void {
    const overlay = $('help-overlay');
    const close = $('help-close');
    $('btn-help').onclick = () => this.toggleHelp();
    close.onclick = () => this.closeHelp();
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.closeHelp();
    });
  }

  private toggleHelp(): void {
    if (this.helpOpen) this.closeHelp();
    else this.openHelp();
  }

  private openHelp(): void {
    this.helpOpen = true;
    $('help-overlay').hidden = false;
    $('help-close').focus();
  }

  private closeHelp(): void {
    this.helpOpen = false;
    $('help-overlay').hidden = true;
    $('btn-help').focus();
  }

  /** 忙碌指示（离线渲染/导出时在状态栏显示 spinner） */
  private setBusy(on: boolean, label?: string): void {
    const el = $('busy');
    const text = el.querySelector<HTMLElement>('.busy-text');
    if (!el || !text) return;
    if (on) {
      if (label) text.textContent = label;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  private updateTransport(): void {
    const play = $('btn-play');
    const playing = this.scheduler.isPlaying;
    play.classList.toggle('playing', playing);
    play.textContent = playing ? '❚❚' : '▶';
    $('btn-record').classList.toggle('on', this.recording);
    $('btn-metro').classList.toggle('on', this.metronome);
    $('btn-undo').toggleAttribute('disabled', !this.history.canUndo);
    $('btn-redo').toggleAttribute('disabled', !this.history.canRedo);

    const bpm = $<HTMLInputElement>('bpm');
    if (document.activeElement !== bpm) bpm.value = String(this.project.tempo);
    const loopEnabled = $<HTMLInputElement>('loop-enabled');
    loopEnabled.checked = this.project.loop.enabled;
    const loopStart = $<HTMLInputElement>('loop-start');
    const loopEnd = $<HTMLInputElement>('loop-end');
    if (document.activeElement !== loopStart) loopStart.value = String(this.project.loop.start);
    if (document.activeElement !== loopEnd) loopEnd.value = String(this.project.loop.end);
  }

  // ---------------- 音阶与和弦建议 ----------------

  private initChordBar(): void {
    const rootSel = $<HTMLSelectElement>('scale-root');
    const typeSel = $<HTMLSelectElement>('scale-type');
    if (!rootSel || !typeSel) return;
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    rootSel.innerHTML = names.map((n, i) => `<option value="${i}"${i === this.scaleRoot ? ' selected' : ''}>${n}</option>`).join('');
    typeSel.innerHTML = SCALES.map((s) => `<option value="${s.id}"${s.id === this.scaleType ? ' selected' : ''}>${s.name}</option>`).join('');
    rootSel.onchange = () => {
      this.scaleRoot = Number(rootSel.value) || 0;
      this.rebuildChords();
    };
    typeSel.onchange = () => {
      this.scaleType = typeSel.value;
      this.rebuildChords();
    };
    this.rebuildChords();
  }

  private rebuildChords(): void {
    this.chords = diatonicChords(this.scaleRoot, scaleById(this.scaleType).intervals, true);
    this.renderChords();
    this.updateChordHighlight();
  }

  private renderChords(): void {
    const list = $('chord-list');
    if (!list) return;
    list.innerHTML = '';
    for (const c of this.chords) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chord-chip';
      chip.dataset.degree = String(c.degree);
      chip.title = `和弦音：${c.tones.map((t) => noteName(t)).join(' · ')}；点击试听`;
      const numeral = document.createElement('b');
      numeral.textContent = c.numeral;
      const symbol = document.createElement('span');
      symbol.textContent = c.symbol;
      chip.appendChild(numeral);
      chip.appendChild(symbol);
      chip.onclick = () => this.auditionChord(c);
      list.appendChild(chip);
    }
  }

  /** 依据播放头附近音高实时高亮最匹配的和弦 */
  private updateChordHighlight(): void {
    const list = $('chord-list');
    if (!list || !this.chords.length) return;
    const clip = this.getSelectedClip();
    const active: number[] = [];
    if (clip) {
      const from = this.playhead - clip.start;
      for (const n of clip.notes) {
        if (n.start >= from && n.start < from + 1) active.push(n.pitch + clip.transpose);
      }
    }
    const best = suggestChord(this.chords, active);
    const key = best ? `${best.degree}:${best.symbol}` : '';
    if (key === this.highlightedChordKey) return;
    this.highlightedChordKey = key;
    list.querySelectorAll<HTMLElement>('.chord-chip').forEach((el) => {
      el.classList.toggle('active', best !== null && el.dataset.degree === String(best.degree));
    });
  }

  private auditionChord(c: Chord): void {
    const track = this.getSelectedTrack();
    if (!track || track.kind === 'audio') {
      this.notify('音频轨无法演奏和弦', 'warn');
      return;
    }
    const index = this.project.tracks.indexOf(track);
    const rootPitch = 60 + (((c.root % 12) + 12) % 12);
    const play = () => {
      c.tones.forEach((pc, i) => {
        const interval = ((pc - c.root) % 12 + 12) % 12;
        engine.note(index, rootPitch + interval, 0.7, 0, 0.9, `ch_${Date.now()}_${i}`, 'normal', { src: 'live' });
      });
    };
    if (engine.ready) play();
    else void engine.ensure().then(() => { engine.syncProject(this.project); play(); }).catch(() => {});
  }

  private setEditorView(view: 'roll' | 'staff'): void {
    const track = this.getSelectedTrack();
    if (view === 'staff' && track && (track.kind === 'audio' || track.instrument.type === 'drum')) {
      this.notify('音频轨 / 鼓轨没有五线谱视图', 'warn');
      return;
    }
    this.pianoroll.setView(view);
    this.updateViewButtons();
  }

  private updateViewButtons(): void {
    const view = this.pianoroll.getView();
    $('btn-view-roll')?.classList.toggle('on', view === 'roll');
    $('btn-view-staff')?.classList.toggle('on', view === 'staff');
  }

  private updateInfo(): void {
    const info = $('timeline-info');
    info.textContent = `${this.project.tracks.length} 轨 · ${this.project.clips.length} 片段 · ${this.project.tempo} BPM`;
    const clipInfo = $('clip-info');
    const clip = this.getSelectedClip();
    const track = this.getSelectedTrack();
    if (clip) {
      const kind = track && track.instrument.type === 'drum' ? ' · 16 分步进' : '';
      clipInfo.textContent = `${clip.name} · ${clip.notes.length} 音符 · ${clip.length} 拍${kind}`;
    } else {
      clipInfo.textContent = '未选择片段';
    }
    this.updateChordHighlight();
  }

  private updatePositionLabel(): void {
    const bpb = beatsPerBarOf(this.project);
    const text = formatBeat(this.playhead, bpb);
    if (text === this.lastPositionText) return;
    this.lastPositionText = text;
    const el = $('position');
    if (el) el.textContent = text;
  }

  private requestFrame(): void {
    const loop = () => {
      if (this.scheduler.isPlaying) {
        this.playhead = this.scheduler.currentBeat();
        this.needsDraw = true;
        this.updatePositionLabel();
        if (this.recording) this.updateInfo();
        else this.updateChordHighlight();
      }
      if (this.needsDraw) {
        this.needsDraw = false;
        this.timeline.render();
        this.pianoroll.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

new App();
