import type { Note } from '../core/types';
import { quantize } from '../core/tempo';
import { DRUM_NAMES, DRUM_ORDER } from '../core/instrument-defaults';
import { spellPitch, alterMark } from '../core/notation';
import {
  cloneNotes, notesInRect, pasteNotes, removeNotesById, setNotesVelocity, nudgeNotes,
} from '../core/note-edit';
import type { AppUi } from './context';

const LABEL_W = 64;
const RULER = 24;

type Mode = 'create' | 'move' | 'resize' | 'velocity' | 'marquee' | null;

interface DragOrigin {
  start: number;
  pitch: number;
  length: number;
  velocity: number;
}

export class PianoRoll {
  private canvas: HTMLCanvasElement;
  private ui: AppUi;
  private ppb = 44;
  private viewStart = 0;
  private maxPitch = 84;
  private minPitch = 48;
  private rowH = 16;
  private mode: Mode = null;
  private activeNote: Note | null = null;
  private dragStartBeat = 0;
  private dragStartPitch = 0;
  private dragOrigPitch = 0;
  private dragOrigVel = 0.8;
  private velocityAnchorY = 0;
  private dragOrigins = new Map<string, DragOrigin>();
  private marquee: { beat0: number; beat1: number; pitch0: number; pitch1: number } | null = null;
  private marqueeBase = new Set<string>();
  private clipboard: Note[] = [];
  private lastClipId: string | null = null;
  private width = 0;
  private height = 0;
  private view: 'roll' | 'staff' = 'roll';
  selectedIds = new Set<string>();

  constructor(canvas: HTMLCanvasElement, ui: AppUi) {
    this.canvas = canvas;
    this.ui = ui;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', () => this.onUp());
    canvas.addEventListener('pointercancel', () => this.onUp());
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.deleteAt(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.ppb = Math.max(8, Math.min(160, this.ppb * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      } else {
        this.viewStart = Math.max(0, this.viewStart + e.deltaX / this.ppb + (e.shiftKey ? e.deltaY : 0) / this.ppb);
      }
      this.render();
    }, { passive: false });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement || canvas);
  }

  private get isDrum(): boolean {
    const track = this.ui.getSelectedTrack();
    return !!track && track.instrument.type === 'drum';
  }

  private fit(): void {
    const clip = this.ui.getSelectedClip();
    if (!clip) return;
    this.viewStart = 0;
    if (this.isDrum) {
      this.rowH = Math.max(18, Math.min(30, Math.floor((this.height - RULER - 10) / DRUM_ORDER.length)));
      this.ppb = Math.max(24, Math.min(120, (this.width - LABEL_W - 20) / Math.max(1, clip.length)));
    } else {
      let lo = 127;
      let hi = 0;
      for (const n of clip.notes) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      if (!clip.notes.length) {
        lo = 48;
        hi = 84;
      }
      this.minPitch = Math.max(24, lo - 3);
      this.maxPitch = Math.min(108, hi + 3);
      const rows = this.maxPitch - this.minPitch + 1;
      this.rowH = Math.max(10, Math.min(20, Math.floor((this.height - RULER - 8) / rows)));
      this.ppb = Math.max(18, Math.min(110, (this.width - LABEL_W - 16) / Math.max(1, clip.length)));
    }
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    const clip = this.ui.getSelectedClip();
    if (clip) {
      if (clip.id !== this.lastClipId) {
        this.lastClipId = clip.id;
        this.selectedIds.clear();
      }
      this.fit();
    }
    this.render();
  }

  private beatToX(beat: number): number {
    return LABEL_W + (beat - this.viewStart) * this.ppb;
  }
  private xToBeat(x: number): number {
    return this.viewStart + (x - LABEL_W) / this.ppb;
  }
  private yToPitch(y: number): number {
    const row = Math.floor((y - RULER) / this.rowH);
    return this.maxPitch - row;
  }
  private pitchToY(pitch: number): number {
    return RULER + (this.maxPitch - pitch) * this.rowH;
  }

  private noteRect(note: Note): { x: number; y: number; w: number; h: number } {
    return {
      x: this.beatToX(note.start),
      y: this.pitchToY(note.pitch),
      w: Math.max(3, note.length * this.ppb),
      h: this.rowH - 1,
    };
  }

  private hitNote(x: number, y: number): Note | null {
    const clip = this.ui.getSelectedClip();
    if (!clip) return null;
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      const r = this.noteRect(n);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return n;
    }
    return null;
  }

  private captureOrigins(clipNotes: Note[]): void {
    this.dragOrigins.clear();
    for (const n of clipNotes) {
      this.dragOrigins.set(n.id, {
        start: n.start,
        pitch: n.pitch,
        length: n.length,
        velocity: n.velocity,
      });
    }
  }

  private selectionChanged(): void {
    this.render();
    this.ui.refreshInspector();
  }

  private onDown(e: PointerEvent): void {
    const clip = this.ui.getSelectedClip();
    if (!clip) return;
    if (this.ui.getSelectedTrack()?.kind === 'audio') return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (this.isDrum) {
      this.onDrumDown(e, clip.notes);
      return;
    }
    if (e.offsetX < LABEL_W) return;
    const note = this.hitNote(e.offsetX, e.offsetY);
    if (note) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        // Ctrl/Cmd 点击：加入或移出选择，不开始拖动
        if (this.selectedIds.has(note.id)) this.selectedIds.delete(note.id);
        else this.selectedIds.add(note.id);
        this.activeNote = note;
        this.mode = null;
        this.selectionChanged();
        return;
      }
      if (!this.selectedIds.has(note.id)) {
        this.selectedIds.clear();
        this.selectedIds.add(note.id);
      }
      this.activeNote = note;
      this.dragStartBeat = this.xToBeat(e.offsetX);
      this.dragStartPitch = this.yToPitch(e.offsetY);
      this.dragOrigPitch = note.pitch;
      this.dragOrigVel = note.velocity;
      this.velocityAnchorY = e.offsetY;
      this.captureOrigins(clip.notes.filter((n) => this.selectedIds.has(n.id)));
      if (e.shiftKey) this.mode = 'velocity';
      else {
        const r = this.noteRect(note);
        this.mode = e.offsetX > r.x + r.w - 6 ? 'resize' : 'move';
      }
      this.selectionChanged();
      return;
    }
    // 空白处：Ctrl/Cmd 或 Shift 开始框选
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      this.mode = 'marquee';
      this.activeNote = null;
      this.marqueeBase = e.shiftKey ? new Set(this.selectedIds) : new Set();
      this.marquee = {
        beat0: this.xToBeat(e.offsetX),
        beat1: this.xToBeat(e.offsetX),
        pitch0: this.yToPitch(e.offsetY),
        pitch1: this.yToPitch(e.offsetY),
      };
      this.selectedIds = new Set(this.marqueeBase);
      this.selectionChanged();
      return;
    }
    if (this.ui.isRecording()) return;
    const beat = Math.max(0, quantize(this.xToBeat(e.offsetX), this.ui.getSnap()));
    const pitch = this.yToPitch(e.offsetY);
    if (pitch < 24 || pitch > 108) return;
    const len = Math.max(0.25, this.ui.getSnap() || 0.5);
    const created: Note = {
      id: `n_${Math.random().toString(36).slice(2, 8)}`,
      pitch,
      start: beat,
      length: len,
      velocity: 0.8,
      articulation: 'normal',
    };
    clip.notes.push(created);
    this.selectedIds.clear();
    this.selectedIds.add(created.id);
    this.activeNote = created;
    this.dragStartBeat = this.xToBeat(e.offsetX);
    this.captureOrigins([created]);
    this.mode = 'create';
    this.ui.softUpdate();
    this.selectionChanged();
  }

  private onDrumDown(e: PointerEvent, notes: Note[]): void {
    if (e.offsetX < LABEL_W) return;
    const clip = this.ui.getSelectedClip();
    if (!clip) return;
    const beat = Math.max(0, quantize(this.xToBeat(e.offsetX), 0.25));
    if (beat >= clip.length) return;
    const row = Math.floor((e.offsetY - RULER) / this.rowH);
    const pitch = DRUM_ORDER[row];
    if (pitch === undefined) return;
    const existing = notes.find((n) => n.pitch === pitch && Math.abs(n.start - beat) < 0.06);
    if (existing) {
      if (e.shiftKey) {
        const steps = [0.35, 0.55, 0.75, 0.95];
        const idx = steps.findIndex((v) => v >= existing.velocity + 0.01);
        existing.velocity = steps[(idx + 1) % steps.length];
        this.selectedIds.clear();
        this.selectedIds.add(existing.id);
        this.ui.softUpdate();
        this.selectionChanged();
        this.ui.commit('鼓步进力度');
      } else {
        clip.notes = notes.filter((n) => n !== existing);
        this.selectedIds.delete(existing.id);
        this.ui.softUpdate();
        this.render();
        this.ui.commit('鼓步进');
      }
      return;
    }
    const note: Note = {
      id: `n_${Math.random().toString(36).slice(2, 8)}`,
      pitch,
      start: beat,
      length: 0.18,
      velocity: 0.8,
      articulation: 'normal',
    };
    notes.push(note);
    this.selectedIds.clear();
    this.selectedIds.add(note.id);
    this.ui.softUpdate();
    this.selectionChanged();
    this.ui.commit('鼓步进');
  }

  private onMove(e: PointerEvent): void {
    const clip = this.ui.getSelectedClip();
    if (!clip || !this.mode) return;
    if (this.mode === 'marquee' && this.marquee) {
      this.marquee.beat1 = this.xToBeat(e.offsetX);
      this.marquee.pitch1 = this.yToPitch(e.offsetY);
      const picked = notesInRect(clip.notes, this.marquee.beat0, this.marquee.beat1, this.marquee.pitch0, this.marquee.pitch1);
      this.selectedIds = new Set(this.marqueeBase);
      for (const n of picked) this.selectedIds.add(n.id);
      this.render();
      return;
    }
    const n = this.activeNote;
    if (!n) return;
    if (this.mode === 'move') {
      const dBeat = this.xToBeat(e.offsetX) - this.dragStartBeat;
      const dPitch = this.yToPitch(e.offsetY) - this.dragStartPitch;
      for (const [id, origin] of this.dragOrigins) {
        const target = clip.notes.find((x) => x.id === id);
        if (!target) continue;
        target.start = Math.max(0, quantize(origin.start + dBeat, this.ui.getSnap()));
        target.pitch = Math.max(24, Math.min(108, origin.pitch + dPitch));
      }
    } else if (this.mode === 'resize') {
      n.length = Math.max(0.0625, quantize(this.xToBeat(e.offsetX) - n.start, 0.0625));
    } else if (this.mode === 'velocity') {
      const dy = e.offsetY - this.velocityAnchorY;
      for (const [id, origin] of this.dragOrigins) {
        const target = clip.notes.find((x) => x.id === id);
        if (target) target.velocity = Math.max(0.05, Math.min(1, origin.velocity - dy / 120));
      }
    } else if (this.mode === 'create') {
      n.length = Math.max(0.125, quantize(this.xToBeat(e.offsetX) - n.start, 0.0625));
    }
    this.ui.softUpdate();
    this.render();
  }

  private onUp(): void {
    const clip = this.ui.getSelectedClip();
    if (this.mode === 'marquee') {
      this.marquee = null;
      this.marqueeBase.clear();
      this.mode = null;
      this.activeNote = null;
      this.selectionChanged();
      return;
    }
    if (this.mode && this.activeNote && clip) {
      clip.notes = clip.notes.filter((n) => n.length > 0.03);
      this.ui.commit(this.mode === 'velocity' ? '修改力度' : '编辑音符');
      this.selectionChanged();
    }
    this.mode = null;
    this.activeNote = null;
    this.dragOrigins.clear();
  }

  // ---------------- 公开编辑操作 ----------------

  getView(): 'roll' | 'staff' {
    return this.view;
  }

  setView(view: 'roll' | 'staff'): void {
    if (this.view === view) return;
    this.view = view;
    this.render();
  }

  getSelectedNotes(): Note[] {
    const clip = this.ui.getSelectedClip();
    if (!clip) return [];
    return clip.notes.filter((n) => this.selectedIds.has(n.id));
  }

  hasSelection(): boolean {
    return this.selectedIds.size > 0 && this.getSelectedNotes().length > 0;
  }

  setVelocity(velocity: number): void {
    const notes = this.getSelectedNotes();
    if (!notes.length) return;
    setNotesVelocity(notes, velocity);
    this.ui.softUpdate();
    this.render();
  }

  copySelected(): number {
    const notes = this.getSelectedNotes();
    if (!notes.length) return 0;
    this.clipboard = cloneNotes(notes);
    return notes.length;
  }

  paste(): number {
    const clip = this.ui.getSelectedClip();
    if (!clip || !this.clipboard.length) return 0;
    const dest = this.ui.getPlayhead() - clip.start + clip.offset;
    const pasted = pasteNotes(
      this.clipboard,
      dest,
      clip.length,
      () => `n_${Math.random().toString(36).slice(2, 8)}`,
    );
    if (!pasted.length) return 0;
    clip.notes.push(...pasted);
    this.selectedIds = new Set(pasted.map((n) => n.id));
    this.ui.softUpdate();
    this.render();
    this.ui.commit(`粘贴 ${pasted.length} 个音符`);
    this.ui.refreshInspector();
    return pasted.length;
  }

  selectAll(): number {
    const clip = this.ui.getSelectedClip();
    if (!clip) return 0;
    this.selectedIds = new Set(clip.notes.map((n) => n.id));
    this.selectionChanged();
    return this.selectedIds.size;
  }

  clearSelection(): void {
    this.selectedIds.clear();
    this.selectionChanged();
  }

  nudgeSelected(dBeat: number, dPitch: number): boolean {
    const notes = this.getSelectedNotes();
    if (!notes.length) return false;
    nudgeNotes(notes, dBeat, dPitch);
    this.ui.softUpdate();
    this.render();
    return true;
  }

  /** 删除选中的音符（供主程序 Delete 快捷键调用） */
  deleteSelected(): boolean {
    const clip = this.ui.getSelectedClip();
    if (!clip || !this.hasSelection()) return false;
    const before = clip.notes.length;
    clip.notes = removeNotesById(clip.notes, this.selectedIds);
    if (clip.notes.length === before) return false;
    this.selectedIds.clear();
    this.ui.softUpdate();
    this.render();
    this.ui.commit('删除音符');
    this.ui.refreshInspector();
    return true;
  }

  private deleteAt(x: number, y: number): void {
    const clip = this.ui.getSelectedClip();
    if (!clip) return;
    if (this.isDrum) {
      const beat = quantize(this.xToBeat(x), 0.25);
      const row = Math.floor((y - RULER) / this.rowH);
      const pitch = DRUM_ORDER[row];
      if (pitch === undefined) return;
      const removed = clip.notes.filter((n) => n.pitch === pitch && Math.abs(n.start - beat) < 0.06);
      clip.notes = clip.notes.filter((n) => !(n.pitch === pitch && Math.abs(n.start - beat) < 0.06));
      for (const n of removed) this.selectedIds.delete(n.id);
      this.ui.softUpdate();
      this.render();
      this.ui.commit('删除鼓点');
      return;
    }
    const note = this.hitNote(x, y);
    if (!note) return;
    clip.notes = clip.notes.filter((n) => n.id !== note.id);
    this.selectedIds.delete(note.id);
    this.ui.softUpdate();
    this.render();
    this.ui.commit('删除音符');
    this.ui.refreshInspector();
  }

  private roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr);
    g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr);
    g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
  }

  render(): void {
    const canvas = this.canvas;
    if (!this.width) this.resize();
    const dpr = window.devicePixelRatio || 1;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    g.fillStyle = '#0a0c0f';
    g.fillRect(0, 0, this.width, this.height);

    const clip = this.ui.getSelectedClip();
    if (!clip) {
      g.fillStyle = '#4f555d';
      g.font = '12px Inter, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText('在时间轴中选择或双击一个片段，开始编辑音符', this.width / 2, this.height / 2 - 6);
      g.textAlign = 'left';
      return;
    }
    if (this.ui.getSelectedTrack()?.kind === 'audio') {
      g.fillStyle = '#4f555d';
      g.font = '12px Inter, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText('音频轨没有音符：片段在时间轴上拖动/裁切，素材起点与增益在检查器调整', this.width / 2, this.height / 2 - 6);
      g.textAlign = 'left';
      return;
    }
    g.textBaseline = 'middle';

    if (this.view === 'staff' && !this.isDrum) this.renderStaff(g, clip.notes, clip.length);
    else if (this.isDrum) this.renderDrum(g, clip.notes, clip.length);
    else this.renderNotes(g, clip.notes, clip.length);

    // 片段结束线
    const endX = this.beatToX(clip.length);
    if (endX > LABEL_W && endX < this.width) {
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(Math.floor(endX), RULER, 1, this.height - RULER);
    }

    // 框选矩形
    if (this.mode === 'marquee' && this.marquee) {
      const x0 = this.beatToX(this.marquee.beat0);
      const x1 = this.beatToX(this.marquee.beat1);
      const y0 = this.pitchToY(Math.max(this.marquee.pitch0, this.marquee.pitch1));
      const y1 = this.pitchToY(Math.min(this.marquee.pitch0, this.marquee.pitch1)) + this.rowH;
      g.fillStyle = 'rgba(243,166,60,0.12)';
      g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      g.strokeStyle = 'rgba(243,166,60,0.65)';
      g.lineWidth = 1;
      g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }

    // 播放头（片段内）
    const ph = this.ui.getPlayhead() - clip.start;
    if (ph >= 0 && ph <= clip.length) {
      const x = this.beatToX(ph);
      g.save();
      g.shadowColor = 'rgba(255,95,126,0.7)';
      g.shadowBlur = 9;
      g.fillStyle = '#ff5f7e';
      g.fillRect(x, RULER, 1.5, this.height - RULER);
      g.beginPath();
      g.moveTo(x - 5, RULER);
      g.lineTo(x + 6, RULER);
      g.lineTo(x + 0.5, RULER + 7);
      g.closePath();
      g.fill();
      g.restore();
    }
  }

  private drawRuler(g: CanvasRenderingContext2D, clipLength: number, drum: boolean, label = 'KEY / STEP'): void {
    const grad = g.createLinearGradient(0, 0, 0, RULER);
    grad.addColorStop(0, '#181c21');
    grad.addColorStop(1, '#0e1013');
    g.fillStyle = grad;
    g.fillRect(0, 0, this.width, RULER);
    g.fillStyle = '#171b20';
    g.fillRect(0, 0, LABEL_W, RULER);
    g.fillStyle = '#5b6169';
    g.font = '8px ui-monospace, monospace';
    g.fillText(label, 8, RULER / 2 + 1);

    g.font = '10px ui-monospace, monospace';
    g.fillStyle = '#a3a8b0';
    const step = drum ? 1 : 4;
    const end = Math.min(clipLength, this.viewStart + (this.width - LABEL_W) / this.ppb);
    for (let b = Math.floor(this.viewStart / step) * step; b <= end; b += step) {
      const x = this.beatToX(b);
      if (x < LABEL_W) continue;
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(Math.floor(x), 0, 1, RULER);
      g.fillStyle = '#a3a8b0';
      g.fillText(String(Math.round(b)), x + 4, RULER / 2 + 1);
      if (!drum) {
        for (let s = 1; s < 4; s++) {
          const sx = this.beatToX(b + s);
          if (sx < LABEL_W) continue;
          g.fillStyle = 'rgba(255,255,255,0.08)';
          g.fillRect(Math.floor(sx), RULER - 4, 1, 4);
        }
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, RULER - 1, this.width, 1);
  }

  private drawGrid(g: CanvasRenderingContext2D, clipLength: number, drum: boolean): void {
    const snap = drum ? 0.25 : (this.ui.getSnap() || 0.5);
    const first = Math.floor(this.viewStart / snap) * snap;
    for (let b = first; b <= clipLength; b += snap) {
      const x = this.beatToX(b);
      if (x < LABEL_W || x > this.width) continue;
      const isBeat = Math.abs(b % 1) < 1e-6;
      const isBar = Math.abs(b % 4) < 1e-6;
      g.fillStyle = isBar ? 'rgba(255,255,255,0.13)' : isBeat ? 'rgba(255,255,255,0.065)' : 'rgba(255,255,255,0.025)';
      g.fillRect(x, RULER, 1, this.height - RULER);
    }
  }

  private renderNotes(g: CanvasRenderingContext2D, notes: Note[], clipLength: number): void {
    const rowH = this.rowH;
    // 行背景 + 左侧钢琴键
    for (let p = this.minPitch; p <= this.maxPitch; p++) {
      const y = this.pitchToY(p);
      const isC = p % 12 === 0;
      const isBlack = [1, 3, 6, 8, 10].includes(p % 12);
      g.fillStyle = isBlack ? 'rgba(255,255,255,0.012)' : isC ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.028)';
      g.fillRect(LABEL_W, y, this.width - LABEL_W, rowH);
      // 键盘条
      if (isBlack) {
        g.fillStyle = '#20242a';
        g.fillRect(0, y, LABEL_W, rowH);
        g.fillStyle = '#31373f';
        g.fillRect(0, y, LABEL_W * 0.72, rowH);
      } else {
        g.fillStyle = '#c8cdd3';
        g.fillRect(0, y, LABEL_W, rowH);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(0, y, LABEL_W, 1);
        g.fillStyle = 'rgba(0,0,0,0.08)';
        g.fillRect(0, y + rowH - 1, LABEL_W, 1);
      }
      if (isC) {
        g.fillStyle = '#3c434c';
        g.font = '600 9px ui-monospace, monospace';
        g.fillText(`C${Math.floor(p / 12) - 1}`, LABEL_W - 24, y + rowH / 2);
      }
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(LABEL_W, y + rowH - 1, this.width - LABEL_W, 1);
    }

    this.drawGrid(g, clipLength, false);
    this.drawRuler(g, clipLength, false);

    const track = this.ui.getSelectedTrack();
    const base = track?.color || '#7aa2ff';
    for (const note of notes) {
      const r = this.noteRect(note);
      if (r.x > this.width || r.x + r.w < LABEL_W) continue;
      const selected = this.selectedIds.has(note.id);
      const x = Math.max(r.x, LABEL_W + 1);
      const w = Math.min(r.x + r.w, this.width) - x;
      if (w <= 0) continue;
      const grad = g.createLinearGradient(0, r.y, 0, r.y + r.h);
      const bright = 0.22 + note.velocity * 0.5;
      grad.addColorStop(0, `${base}${Math.round(bright * 255).toString(16).padStart(2, '0')}`);
      grad.addColorStop(1, `${base}${Math.round(bright * 120).toString(16).padStart(2, '0')}`);
      g.fillStyle = grad;
      this.roundRect(g, x, r.y + 1, w, r.h - 2, 3);
      g.fill();
      // 左侧握把
      g.fillStyle = selected ? '#f3a63c' : `${base}cc`;
      g.fillRect(x + 1, r.y + 2, 2.5, r.h - 4);
      if (selected) {
        g.save();
        g.shadowColor = 'rgba(243,166,60,0.6)';
        g.shadowBlur = 8;
        g.strokeStyle = '#f3a63c';
        g.lineWidth = 1.5;
        this.roundRect(g, x + 0.5, r.y + 1.5, w - 1, r.h - 3, 3);
        g.stroke();
        g.restore();
      }
    }
    g.fillStyle = '#4f555d';
    g.font = '9.5px ui-monospace, monospace';
    const selCount = this.selectedIds.size;
    const info = `${clipLength} 拍 · ${notes.length} 音符${selCount ? ` · ${selCount} 选中` : ''}`;
    g.fillText(info, this.width - Math.min(150, info.length * 6), RULER / 2 + 1);
  }

  private renderDrum(g: CanvasRenderingContext2D, notes: Note[], clipLength: number): void {
    const rowH = this.rowH;
    DRUM_ORDER.forEach((pitch, i) => {
      const y = RULER + i * rowH;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.022)' : 'rgba(255,255,255,0.042)';
      g.fillRect(LABEL_W, y, this.width - LABEL_W, rowH);
      g.fillStyle = i % 2 ? '#121519' : '#0f1216';
      g.fillRect(0, y, LABEL_W, rowH);
      g.fillStyle = '#74cf95';
      g.fillRect(0, y + 3, 2, rowH - 6);
      g.fillStyle = '#a3a8b0';
      g.font = '10px Inter, "Segoe UI", sans-serif';
      g.fillText(DRUM_NAMES[pitch] || String(pitch), 9, y + rowH / 2);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, y + rowH - 1, this.width, 1);
    });

    this.drawGrid(g, clipLength, true);
    this.drawRuler(g, clipLength, true);

    const stepW = this.ppb / 4;
    for (const note of notes) {
      const idx = DRUM_ORDER.indexOf(note.pitch);
      if (idx < 0) continue;
      const r = this.noteRect(note);
      if (r.x > this.width || r.x + r.w < LABEL_W) continue;
      const selected = this.selectedIds.has(note.id);
      const w = Math.max(6, stepW - 4);
      const x = r.x + 2;
      const y = RULER + idx * rowH + 3;
      const h = rowH - 6;
      const alpha = 0.32 + note.velocity * 0.55;
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, `rgba(116,207,149,${Math.min(1, alpha + 0.12)})`);
      grad.addColorStop(1, `rgba(40,110,68,${alpha})`);
      g.fillStyle = grad;
      this.roundRect(g, x, y, w, h, 3);
      g.fill();
      g.strokeStyle = selected ? '#f3a63c' : 'rgba(116,207,149,0.5)';
      g.lineWidth = selected ? 1.5 : 1;
      this.roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, 3);
      g.stroke();
      // 力度点
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(x + 2, y + h - 3 - (note.velocity * (h - 6)), 2, 2);
    }
  }

  // ---------------- 五线谱视图（只读显示，非可编辑记谱器） ----------------

  private renderStaff(g: CanvasRenderingContext2D, notes: Note[], clipLength: number): void {
    g.fillStyle = '#0a0c0f';
    g.fillRect(0, RULER, this.width, this.height - RULER);
    g.fillStyle = '#171b20';
    g.fillRect(0, RULER, LABEL_W, this.height - RULER);

    // 步进范围（高音谱表：E4=2 .. F5=10），保留一档余量
    let minStep = 2;
    let maxStep = 10;
    if (notes.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of notes) {
        const s = spellPitch(n.pitch).step;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      minStep = Math.min(2, lo) - 1;
      maxStep = Math.max(10, hi) + 1;
    }
    const padY = 20;
    const avail = this.height - RULER - padY * 2;
    const gap = Math.max(4, Math.min(16, avail / Math.max(8, maxStep - minStep)));
    const baseStep = 2;
    const baseY = RULER + padY + (maxStep - baseStep) * gap;
    const yOf = (step: number) => baseY - (step - baseStep) * gap;

    this.drawGrid(g, clipLength, false);
    this.drawRuler(g, clipLength, false, 'STAFF');

    // 五线（steps 2,4,6,8,10）
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 1;
    for (let s = 2; s <= 10; s += 2) {
      const y = yOf(s);
      g.beginPath();
      g.moveTo(LABEL_W, y);
      g.lineTo(this.width, y);
      g.stroke();
    }

    // 左侧 C 音名标注
    g.fillStyle = '#4f555d';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'left';
    if (0 >= minStep && 0 <= maxStep) g.fillText('C4', 6, yOf(0));
    if (7 >= minStep && 7 <= maxStep) g.fillText('C5', 6, yOf(7));

    const track = this.ui.getSelectedTrack();
    const color = track?.color || '#7aa2ff';

    for (const note of notes) {
      const x = this.beatToX(note.start);
      if (x < LABEL_W - 20 || x > this.width + 20) continue;
      const sp = spellPitch(note.pitch);
      const y = yOf(sp.step);

      // 下加线 / 上加线
      g.strokeStyle = 'rgba(200,205,211,0.55)';
      g.lineWidth = 1;
      if (sp.step <= 0) {
        for (let s = 0; s >= sp.step; s -= 2) {
          g.beginPath();
          g.moveTo(x - 7, yOf(s));
          g.lineTo(x + 10, yOf(s));
          g.stroke();
        }
      }
      if (sp.step >= 12) {
        for (let s = 12; s <= sp.step; s += 2) {
          g.beginPath();
          g.moveTo(x - 7, yOf(s));
          g.lineTo(x + 10, yOf(s));
          g.stroke();
        }
      }

      const headRx = gap * 0.72;
      const headRy = gap * 0.52;
      const selected = this.selectedIds.has(note.id);

      // 符干
      const stemUp = sp.step < 6;
      const stemX = stemUp ? x + headRx : x - headRx;
      const stemLen = gap * 3.5;
      g.strokeStyle = selected ? '#f3a63c' : 'rgba(255,255,255,0.5)';
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(stemX, y);
      g.lineTo(stemX, stemUp ? y - stemLen : y + stemLen);
      g.stroke();

      // 符头
      g.fillStyle = selected ? '#f3a63c' : color;
      g.beginPath();
      g.ellipse(x, y, headRx, headRy, -0.35, 0, Math.PI * 2);
      g.fill();
      if (selected) {
        g.strokeStyle = '#f3a63c';
        g.lineWidth = 1.2;
        g.beginPath();
        g.ellipse(x, y, headRx + 1, headRy + 1, -0.35, 0, Math.PI * 2);
        g.stroke();
      }

      // 临时升降号
      if (sp.alter !== 0) {
        g.fillStyle = '#d9a0e8';
        g.font = `600 ${Math.max(9, gap * 1.1)}px Inter, "Segoe UI", sans-serif`;
        g.textAlign = 'center';
        g.fillText(alterMark(sp.alter), x - headRx - gap * 0.9, y + 1);
        g.textAlign = 'left';
      }
    }

    g.fillStyle = '#4f555d';
    g.font = '9.5px ui-monospace, monospace';
    g.textAlign = 'left';
    g.fillText(`${clipLength} 拍 · ${notes.length} 音符 · 五线谱（只读）`, LABEL_W + 8, this.height - 8);
  }
}
