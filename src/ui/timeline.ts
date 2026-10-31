import type { Clip } from '../core/types';
import { quantize } from '../core/tempo';
import { PEAK_BINS_PER_SEC, assetById } from '../core/audio-asset';
import type { AppUi } from './context';

const RULER = 28;
const ROW = 58;
const LEFT = 136;

type DragMode = 'seek' | 'move' | 'resize' | null;

export class Timeline {
  private canvas: HTMLCanvasElement;
  private ui: AppUi;
  private ppb = 36;
  private viewStart = 0;
  private drag: DragMode = null;
  private dragClip: Clip | null = null;
  private dragStartBeat = 0;
  private dragOrigStart = 0;
  private dragOrigLength = 0;
  private dragPointerX = 0;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement, ui: AppUi) {
    this.canvas = canvas;
    this.ui = ui;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.hitClip(e.offsetX, e.offsetY);
      if (hit) this.ui.selectClip(hit.id);
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-soundweave-block')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    canvas.addEventListener('drop', (e) => this.onDrop(e));
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement || canvas);
  }

  get viewLength(): number {
    return this.width - LEFT;
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    this.width = parent.clientWidth;
    const project = this.ui.getProject();
    const rows = Math.max(3, project.tracks.length);
    this.height = Math.max(parent.clientHeight, RULER + rows * ROW + 8);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.render();
  }

  zoomBy(factor: number): void {
    const center = this.viewStart + this.viewLength / this.ppb / 2;
    this.ppb = Math.max(10, Math.min(160, this.ppb * factor));
    this.viewStart = Math.max(0, center - this.viewLength / this.ppb / 2);
    this.render();
  }

  private beatToX(beat: number): number {
    return LEFT + (beat - this.viewStart) * this.ppb;
  }

  private xToBeat(x: number): number {
    return this.viewStart + (x - LEFT) / this.ppb;
  }

  private trackAt(y: number): number {
    if (y < RULER) return -1;
    return Math.floor((y - RULER) / ROW);
  }

  private clipRect(clip: Clip): { x: number; y: number; w: number; h: number; index: number } | null {
    const project = this.ui.getProject();
    const index = project.tracks.findIndex((t) => t.id === clip.trackId);
    if (index < 0) return null;
    const x = this.beatToX(clip.start);
    const w = clip.length * this.ppb;
    return { x, y: RULER + index * ROW + 6, w, h: ROW - 12, index };
  }

  private hitClip(x: number, y: number): Clip | null {
    const ti = this.trackAt(y);
    if (ti < 0) return null;
    const project = this.ui.getProject();
    const track = project.tracks[ti];
    if (!track) return null;
    for (let i = project.clips.length - 1; i >= 0; i--) {
      const c = project.clips[i];
      if (c.trackId !== track.id) continue;
      const r = this.clipRect(c);
      if (!r) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return c;
    }
    return null;
  }

  private onDown(e: PointerEvent): void {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const project = this.ui.getProject();
    if (e.offsetY < RULER) {
      this.drag = 'seek';
      this.ui.setPlayhead(quantize(this.xToBeat(Math.max(LEFT, e.offsetX)), this.ui.getSnap()), true);
      this.render();
      return;
    }
    if (e.offsetX < LEFT) {
      const ti = this.trackAt(e.offsetY);
      if (ti >= 0 && project.tracks[ti]) this.ui.selectTrack(project.tracks[ti].id);
      this.ui.refresh();
      return;
    }
    const clip = this.hitClip(e.offsetX, e.offsetY);
    if (clip) {
      this.ui.selectClip(clip.id);
      const r = this.clipRect(clip);
      this.dragClip = clip;
      this.dragStartBeat = this.xToBeat(e.offsetX);
      this.dragOrigStart = clip.start;
      this.dragOrigLength = clip.length;
      this.dragPointerX = e.offsetX;
      this.drag = r && e.offsetX > r.x + r.w - 8 ? 'resize' : 'move';
      this.ui.refresh();
      this.render();
      return;
    }
    const ti = this.trackAt(e.offsetY);
    if (ti >= 0 && project.tracks[ti]) {
      this.ui.selectTrack(project.tracks[ti].id);
      this.ui.selectClip(null);
      this.ui.setPlayhead(quantize(Math.max(0, this.xToBeat(e.offsetX)), this.ui.getSnap()), true);
      this.ui.refresh();
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.drag === 'seek') {
      this.ui.setPlayhead(quantize(Math.max(0, this.xToBeat(Math.max(LEFT, e.offsetX))), this.ui.getSnap()), true);
      this.render();
      return;
    }
    if (this.drag && this.dragClip) {
      const clip = this.dragClip;
      if (this.drag === 'move') {
        const delta = (e.offsetX - this.dragPointerX) / this.ppb;
        clip.start = Math.max(0, quantize(this.dragOrigStart + delta, this.ui.getSnap()));
      } else if (this.drag === 'resize') {
        const len = this.dragOrigLength + (e.offsetX - this.dragPointerX) / this.ppb;
        clip.length = Math.max(0.25, quantize(len, this.ui.getSnap()));
      }
      this.ui.softUpdate();
      this.render();
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.drag === 'seek') {
      this.drag = null;
      return;
    }
    if (this.drag && this.dragClip) {
      const c = this.dragClip;
      // 裁掉超出片段边界的音符坐标仍有效（offset 表示源内偏移）
      if (c.start < 0) c.start = 0;
      this.drag = null;
      this.dragClip = null;
      this.ui.commit('移动片段');
    }
    this.drag = null;
  }

  private onDouble(e: MouseEvent): void {
    const project = this.ui.getProject();
    const clip = this.hitClip(e.offsetX, e.offsetY);
    if (clip) {
      this.ui.selectClip(clip.id, true);
      return;
    }
    const ti = this.trackAt(e.offsetY);
    if (ti < 0 || !project.tracks[ti]) return;
    const track = project.tracks[ti];
    if (track.kind === 'audio') {
      this.ui.notify('音频轨请用文件栏的「导入 WAV」添加片段', 'warn');
      return;
    }
    const start = Math.max(0, quantize(this.xToBeat(e.offsetX), this.ui.getSnap()));
    const clip2: Clip = {
      id: `c_${Math.random().toString(36).slice(2, 8)}`,
      trackId: track.id,
      name: '空片段',
      start,
      length: 4,
      offset: 0,
      transpose: 0,
      notes: [],
    };
    project.clips.push(clip2);
    this.ui.selectTrack(track.id);
    this.ui.selectClip(clip2.id, true);
    this.ui.commit('新建片段');
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const anchorBeat = this.xToBeat(Math.max(LEFT, e.offsetX));
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.ppb = Math.max(10, Math.min(160, this.ppb * factor));
      this.viewStart = Math.max(0, anchorBeat - (Math.max(LEFT, e.offsetX) - LEFT) / this.ppb);
    } else {
      this.viewStart = Math.max(0, this.viewStart + (e.deltaY + e.deltaX) / this.ppb);
    }
    this.render();
  }

  private onDrop(e: DragEvent): void {
    const blockId = e.dataTransfer?.getData('application/x-soundweave-block');
    if (!blockId) return;
    e.preventDefault();
    const project = this.ui.getProject();
    const ti = this.trackAt(e.offsetY);
    if (ti < 0 || !project.tracks[ti]) return;
    const beat = Math.max(0, quantize(this.xToBeat(e.offsetX), this.ui.getSnap()));
    this.ui.insertBlock(blockId, project.tracks[ti].id, beat);
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

    const project = this.ui.getProject();
    const bpb = project.timeSig[0] * 4 / project.timeSig[1];
    const beatEnd = this.viewStart + this.viewLength / this.ppb;

    // 底色
    g.fillStyle = '#0a0c0f';
    g.fillRect(0, 0, this.width, this.height);

    // 小节竖线（贯穿轨道区）
    const firstBar = Math.max(0, Math.floor(this.viewStart / bpb));
    g.fillStyle = 'rgba(255,255,255,0.045)';
    for (let bar = firstBar; bar * bpb <= beatEnd; bar++) {
      const x = this.beatToX(bar * bpb);
      if (x >= LEFT) g.fillRect(Math.floor(x), RULER, 1, this.height - RULER);
    }

    // 标尺
    const rulerGrad = g.createLinearGradient(0, 0, 0, RULER);
    rulerGrad.addColorStop(0, '#181c21');
    rulerGrad.addColorStop(1, '#0f1215');
    g.fillStyle = rulerGrad;
    g.fillRect(LEFT, 0, this.width - LEFT, RULER);
    g.fillStyle = '#171b20';
    g.fillRect(0, 0, LEFT, RULER);
    g.fillStyle = '#c1c5cb';
    g.font = '10px ui-monospace, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let bar = firstBar; bar * bpb <= beatEnd; bar++) {
      const x = this.beatToX(bar * bpb);
      if (x >= LEFT) {
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(Math.floor(x), 0, 1, RULER);
        g.fillStyle = '#a8adb5';
        g.fillText(String(bar + 1).padStart(2, '0'), x + 5, RULER / 2 + 1);
      }
      for (let b = 1; b < bpb; b++) {
        const bx = this.beatToX(bar * bpb + b);
        if (bx >= LEFT) {
          g.fillStyle = 'rgba(255,255,255,0.12)';
          g.fillRect(Math.floor(bx), RULER - 5, 1, 5);
        }
      }
    }

    // 循环区域
    if (project.loop.enabled) {
      const x1 = Math.max(LEFT, this.beatToX(project.loop.start));
      const x2 = Math.min(this.width, this.beatToX(project.loop.end));
      if (x2 > x1) {
        g.fillStyle = 'rgba(243,166,60,0.14)';
        g.fillRect(x1, 0, x2 - x1, RULER);
        g.fillStyle = 'rgba(243,166,60,0.9)';
        g.fillRect(x1, 0, 2, RULER);
        g.fillRect(x2 - 2, 0, 2, RULER);
      }
    }

    // 轨道
    const typeLabel: Record<string, string> = { ep: '电钢琴', piano: '钢琴', guitar: '吉他', synth: '合成器', bass: '贝斯', drum: '鼓机' };
    project.tracks.forEach((track, i) => {
      const y = RULER + i * ROW;
      const selected = track.id === this.ui.getSelectedTrackId();
      // 轨道头
      g.fillStyle = selected ? '#181c21' : '#0f1215';
      g.fillRect(0, y, LEFT, ROW);
      g.fillStyle = track.color;
      g.globalAlpha = selected ? 0.95 : 0.55;
      g.fillRect(0, y, 2, ROW);
      g.globalAlpha = 1;
      g.fillStyle = selected ? 'rgba(255,255,255,0.06)' : '#111418';
      g.fillRect(LEFT, y, this.width - LEFT, ROW);
      // 序号
      g.fillStyle = '#5a6068';
      g.font = '9px ui-monospace, monospace';
      g.fillText(String(i + 1).padStart(2, '0'), 10, y + 15);
      // 名称与类型
      g.fillStyle = selected ? '#ffffff' : '#d3d6da';
      g.font = '600 12px Inter, "Segoe UI", sans-serif';
      g.fillText(track.name, 26, y + 18);
      g.fillStyle = '#6b7078';
      g.font = '10px Inter, "Segoe UI", sans-serif';
      g.fillText(track.kind === 'audio' ? '音频' : typeLabel[track.instrument.type] || track.instrument.type, 26, y + 37);
      // M / S
      g.font = '600 9px ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillStyle = track.mute ? '#ff5f7e' : '#3a4048';
      g.fillText('M', 106, y + 17);
      g.fillStyle = track.solo ? '#ffd166' : '#3a4048';
      g.fillText('S', 122, y + 17);
      g.textAlign = 'left';
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, y + ROW - 1, this.width, 1);
    });

    // 片段
    for (const clip of project.clips) {
      const r = this.clipRect(clip);
      if (!r) continue;
      const x2 = Math.min(this.width, r.x + r.w);
      if (x2 < LEFT || r.x > this.width) continue;
      const selected = clip.id === this.ui.getSelectedClipId();
      const track = project.tracks[r.index];
      const w = Math.max(3, r.w);
      const grad = g.createLinearGradient(0, r.y, 0, r.y + r.h);
      grad.addColorStop(0, `${track.color}52`);
      grad.addColorStop(0.55, `${track.color}2e`);
      grad.addColorStop(1, `${track.color}1c`);
      g.fillStyle = grad;
      this.roundRect(g, r.x, r.y, w, r.h, 4);
      g.fill();
      // 顶部高光
      g.strokeStyle = `${track.color}aa`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(r.x + 3, r.y + 1);
      g.lineTo(r.x + w - 3, r.y + 1);
      g.stroke();
      // 边框
      g.strokeStyle = selected ? '#f3a63c' : `${track.color}8a`;
      g.lineWidth = selected ? 1.5 : 1;
      this.roundRect(g, r.x + 0.5, r.y + 0.5, w - 1, r.h - 1, 4);
      g.stroke();
      // 名称
      g.fillStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.88)';
      g.font = '600 10px Inter, "Segoe UI", sans-serif';
      g.fillText(clip.name.slice(0, 22), r.x + 7, r.y + 14);

      // 音频片段波形（峰值来自素材，按片段可见的源区间取样）
      if (clip.audio) {
        const asset = assetById(project.audioAssets, clip.audio.assetId);
        const ax = Math.max(r.x + 3, LEFT);
        const axEnd = Math.min(r.x + w - 3, this.width);
        const top = r.y + 20;
        const hgt = Math.max(6, r.h - 26);
        const center = top + hgt / 2;
        if (asset?.peaks?.length) {
          const clipSec = (clip.length * 60) / Math.max(30, project.tempo);
          g.fillStyle = selected ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.34)';
          for (let x = ax; x < axEnd; x++) {
            const t = (x - r.x) / Math.max(1, w);
            const bin = Math.floor((clip.audio.offsetSec + t * clipSec) * PEAK_BINS_PER_SEC);
            const v = bin >= 0 && bin < asset.peaks.length ? asset.peaks[bin] : 0;
            const amp = (v * hgt) / 2;
            g.fillRect(x, center - amp, 1, Math.max(1, amp * 2));
          }
        }
        if (!asset || !asset.data) {
          g.fillStyle = 'rgba(255,183,94,0.9)';
          g.font = '10px Inter, "Segoe UI", sans-serif';
          g.textAlign = 'center';
          g.fillText('素材缺失 · 重新导入 WAV', (ax + axEnd) / 2, r.y + r.h - 7);
          g.textAlign = 'left';
        }
      }

      // 音符缩略
      if (clip.notes.length) {
        let lo = 127;
        let hi = 0;
        for (const n of clip.notes) {
          lo = Math.min(lo, n.pitch);
          hi = Math.max(hi, n.pitch);
        }
        const span = Math.max(1, hi - lo);
        const top = r.y + 22;
        const hgt = r.h - 28;
        const nh = Math.max(1.5, Math.min(3, hgt / Math.max(6, span)));
        g.fillStyle = selected ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.42)';
        for (const note of clip.notes) {
          const nx = this.beatToX(clip.start + note.start - clip.offset);
          const nw = Math.max(2, note.length * this.ppb);
          if (nx > this.width || nx + nw < LEFT) continue;
          const ny = top + hgt - ((note.pitch - lo) / span) * hgt;
          g.fillRect(nx, ny, nw, nh);
        }
      }
    }

    // 未分配片段区提示
    if (!project.clips.length) {
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.font = '11px Inter, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText('双击轨道区域新建片段，或从左侧拖入编曲块', LEFT + this.viewLength / 2, RULER + 44);
      g.textAlign = 'left';
    }

    // 播放头
    const ph = this.ui.getPlayhead();
    const px = this.beatToX(ph);
    if (px >= LEFT && px <= this.width) {
      g.save();
      g.shadowColor = 'rgba(255,95,126,0.7)';
      g.shadowBlur = 10;
      g.fillStyle = '#ff5f7e';
      g.fillRect(px, 0, 1.5, this.height);
      g.beginPath();
      g.moveTo(px - 5, 0);
      g.lineTo(px + 6.5, 0);
      g.lineTo(px + 0.75, 8);
      g.closePath();
      g.fill();
      g.restore();
    }
  }
}
