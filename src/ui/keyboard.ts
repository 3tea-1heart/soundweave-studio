import { DRUM_ORDER, DRUM_NAMES } from '../core/instrument-defaults';
import type { AppUi } from './context';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const KEYMAP: Record<string, number> = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  q: 12, '2': 13, w: 14, '3': 15, e: 16, r: 17, '5': 18, t: 19, '6': 20, y: 21, '7': 22, u: 23,
  i: 24, '9': 25, o: 26, '0': 27, p: 28,
};

export class Keyboard {
  private el: HTMLElement;
  private ui: AppUi;
  private base = 60;
  private keys = new Map<number, HTMLButtonElement>();
  private held = new Map<string, { pitch: number; id: string; button: HTMLButtonElement | null }>();
  private computerHeld = new Set<string>();
  private activePointerId: number | null = null;

  constructor(el: HTMLElement, ui: AppUi) {
    this.el = el;
    this.ui = ui;
    this.build();
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseAll());
  }

  private get drumMode(): boolean {
    const t = this.ui.getSelectedTrack();
    return !!t && t.instrument.type === 'drum';
  }

  private build(): void {
    this.el.innerHTML = '';
    this.keys.clear();
    const header = document.createElement('div');
    header.className = 'kb-header';
    const title = document.createElement('span');
    title.textContent = this.drumMode ? '虚拟打击垫（点击或使用键盘）' : `演奏键盘 · 基准 C${Math.floor(this.base / 12) - 1}`;
    header.appendChild(title);
    const octave = document.createElement('div');
    octave.className = 'kb-octave';
    const down = document.createElement('button');
    down.textContent = '−';
    down.title = '降低八度';
    down.setAttribute('aria-label', '降低八度');
    down.onclick = () => { this.base = Math.max(24, this.base - 12); this.build(); };
    const up = document.createElement('button');
    up.textContent = '+';
    up.title = '升高八度';
    up.setAttribute('aria-label', '升高八度');
    up.onclick = () => { this.base = Math.min(96, this.base + 12); this.build(); };
    const hint = document.createElement('span');
    hint.textContent = 'Z–M / Q–P';
    octave.append(down, hint, up);
    header.appendChild(octave);
    this.el.appendChild(header);

    const board = document.createElement('div');
    board.className = 'kb-board';
    if (this.drumMode) {
      for (const pitch of DRUM_ORDER) {
        const b = document.createElement('button');
        b.className = 'drum-pad';
        b.textContent = DRUM_NAMES[pitch] || String(pitch);
        b.setAttribute('aria-label', DRUM_NAMES[pitch] || String(pitch));
        b.dataset.pitch = String(pitch);
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.press(pitch, b);
          this.activePointerId = e.pointerId;
        });
        board.appendChild(b);
        this.keys.set(pitch, b);
      }
    } else {
      const whiteCount = 15;
      for (let i = 0; i < whiteCount; i++) {
        const oct = Math.floor(i / 7);
        const idx = i % 7;
        const semis = [0, 2, 4, 5, 7, 9, 11][idx];
        const pitch = this.base + oct * 12 + semis;
        const b = document.createElement('button');
        b.className = 'white-key';
        b.dataset.pitch = String(pitch);
        b.setAttribute('aria-label', `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`);
        b.innerHTML = `<span>${NOTE_NAMES[pitch % 12]}</span><small>${Math.floor(pitch / 12) - 1}</small>`;
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.press(pitch, b);
          this.activePointerId = e.pointerId;
        });
        board.appendChild(b);
        this.keys.set(pitch, b);
      }
      for (let i = 0; i < whiteCount - 1; i++) {
        const oct = Math.floor(i / 7);
        const idx = i % 7;
        if (idx === 2 || idx === 6) continue;
        const semis = [0, 2, 4, 5, 7, 9, 11][idx] + 1;
        const pitch = this.base + oct * 12 + semis;
        const b = document.createElement('button');
        b.className = 'black-key';
        b.dataset.pitch = String(pitch);
        b.setAttribute('aria-label', `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`);
        b.style.left = `${((i + 1) / whiteCount) * 100}%`;
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.press(pitch, b);
          this.activePointerId = e.pointerId;
        });
        board.appendChild(b);
        this.keys.set(pitch, b);
      }
    }
    this.el.appendChild(board);
    window.addEventListener('pointerup', (e) => {
      if (this.activePointerId !== null && e.pointerId === this.activePointerId) {
        this.releaseAll();
        this.activePointerId = null;
      }
    });
  }

  private press(pitch: number, button: HTMLButtonElement | null): void {
    if (this.held.has(`ui:${pitch}`)) return;
    const id = this.ui.liveNoteOn(pitch, 0.78, 'normal');
    button?.classList.add('active');
    this.held.set(`ui:${pitch}`, { pitch, id, button });
  }

  private releaseAll(): void {
    for (const [, v] of this.held) {
      this.ui.liveNoteOff(v.id);
      v.button?.classList.remove('active');
    }
    this.held.clear();
    this.computerHeld.clear();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (!KEYMAP[key] && !e.shiftKey) {
      if (key === '[') {
        this.base = Math.max(24, this.base - 12);
        this.build();
        return;
      }
      if (key === ']') {
        this.base = Math.min(96, this.base + 12);
        this.build();
        return;
      }
    }
    if (KEYMAP[key] === undefined) return;
    if (this.computerHeld.has(key)) return;
    e.preventDefault();
    this.computerHeld.add(key);
    const pitch = this.drumMode ? DRUM_ORDER[KEYMAP[key] % DRUM_ORDER.length] : this.base + KEYMAP[key];
    const button = this.keys.get(pitch) || null;
    const id = this.ui.liveNoteOn(pitch, 0.78, e.shiftKey ? 'mute' : 'normal');
    button?.classList.add('active');
    this.held.set(`k:${key}`, { pitch, id, button });
  }

  private onKeyUp(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    const v = this.held.get(`k:${key}`);
    if (!v) return;
    this.computerHeld.delete(key);
    this.ui.liveNoteOff(v.id);
    v.button?.classList.remove('active');
    this.held.delete(`k:${key}`);
  }

  rebuild(): void {
    this.releaseAll();
    this.build();
  }
}
