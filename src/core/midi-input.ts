/**
 * Web MIDI 输入：设备接入、音符、延音踏板（CC64）、全部停音（CC123）、
 * 弯音（Pitch Bend）、通道/复音触后与供 MIDI Learn 使用的 CC。
 * 只依赖轻量结构类型，避免不同 TypeScript lib 是否内置 Web MIDI 声明影响构建。
 */

import { bendValue } from './midi-learn';

export interface MidiHandlers {
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
  /** 弯音：14-bit 归一化为 -1..1 */
  bend(value: number): void;
  /** 触后：0..1（复音触后按通道触后近似处理） */
  pressure(value: number): void;
  /** 未被内置语义占用的控制器，供 MIDI Learn 绑定 */
  control(cc: number, value: number): void;
  /** 状态栏文本与「是否有设备」标志 */
  status(text: string, connected: boolean): void;
}

interface MidiPortLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

interface MidiAccessLike {
  inputs: Map<string, MidiPortLike>;
  onstatechange: ((event: unknown) => void) | null;
}

type MidiAccessRequest = (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;

function requestAccess(): MidiAccessRequest | null {
  const nav = navigator as unknown as { requestMIDIAccess?: MidiAccessRequest };
  return nav.requestMIDIAccess ?? null;
}

/** MIDI 力度 1–127 → 0.05–1，与屏幕键盘走同一条实时演奏入口 */
export function midiVelocity(raw: number): number {
  return Math.max(0.05, Math.min(1, raw / 127));
}

export class MidiInput {
  private access: MidiAccessLike | null = null;
  private handlers: MidiHandlers;
  private pedalDown = false;
  private sounding = new Set<number>();
  private sustained = new Set<number>();
  private bound = new Set<string>();

  constructor(handlers: MidiHandlers) {
    this.handlers = handlers;
  }

  get enabled(): boolean {
    return !!this.access;
  }

  async enable(): Promise<boolean> {
    const request = requestAccess();
    if (!request) {
      this.handlers.status('此浏览器不支持 Web MIDI（请使用 Chrome / Edge）', false);
      return false;
    }
    try {
      this.access = await request({ sysex: false });
    } catch {
      this.access = null;
      this.handlers.status('未获得 MIDI 访问权限（请在站点权限中允许）', false);
      return false;
    }
    this.access.onstatechange = () => this.refresh();
    this.refresh();
    return true;
  }

  /** 重新扫描设备；已绑定过的端口不重复挂监听（热插拔时新端口会被绑定） */
  refresh(): void {
    const access = this.access;
    if (!access) {
      this.handlers.status('MIDI 未连接', false);
      return;
    }
    for (const port of access.inputs.values()) {
      if (this.bound.has(port.id)) continue;
      this.bound.add(port.id);
      port.onmidimessage = (event) => this.onMessage(event.data);
    }
    const ports = Array.from(access.inputs.values());
    const active = ports.filter((p) => (p.state ?? 'connected') === 'connected');
    const names = active.map((p) => p.name || p.id);
    this.handlers.status(
      active.length
        ? `MIDI · ${active.length} 台 · ${names.slice(0, 2).join(' / ')}`
        : 'MIDI 已启用 · 未检测到设备',
      active.length > 0,
    );
  }

  private onMessage(data: Uint8Array): void {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    if (status === 0x90) {
      const pitch = data[1];
      const velocity = data[2] ?? 0;
      if (velocity === 0) this.noteOff(pitch);
      else this.noteOn(pitch, velocity);
    } else if (status === 0x80) {
      this.noteOff(data[1]);
    } else if (status === 0xb0 && data.length >= 3) {
      if (data[1] === 64) this.setPedal(data[2] >= 64);
      else if (data[1] === 123) this.releaseAll();
      else this.handlers.control(data[1], data[2]);
    } else if (status === 0xe0 && data.length >= 3) {
      // 14-bit 弯音：低 7 位在前，中心 8192
      const raw = ((data[2] & 0x7f) << 7) | (data[1] & 0x7f);
      this.handlers.bend(bendValue(raw));
    } else if (status === 0xd0) {
      this.handlers.pressure((data[1] ?? 0) / 127);
    } else if (status === 0xa0 && data.length >= 3) {
      // 复音触后：DSP 只提供通道级压力，取该音的压力值近似
      this.handlers.pressure((data[2] ?? 0) / 127);
    }
  }

  private noteOn(pitch: number, velocity: number): void {
    this.sustained.delete(pitch);
    if (this.sounding.has(pitch)) return;
    this.sounding.add(pitch);
    this.handlers.noteOn(pitch, midiVelocity(velocity));
  }

  private noteOff(pitch: number): void {
    if (!this.sounding.has(pitch)) return;
    if (this.pedalDown) {
      this.sustained.add(pitch);
      return;
    }
    this.sounding.delete(pitch);
    this.handlers.noteOff(pitch);
  }

  private setPedal(down: boolean): void {
    if (down === this.pedalDown) return;
    this.pedalDown = down;
    if (down) return;
    for (const pitch of this.sustained) {
      if (this.sounding.delete(pitch)) this.handlers.noteOff(pitch);
    }
    this.sustained.clear();
  }

  releaseAll(): void {
    for (const pitch of this.sounding) this.handlers.noteOff(pitch);
    this.sounding.clear();
    this.sustained.clear();
    this.pedalDown = false;
    // 全部停音同时归零弯音与触后，避免回到页面后音高卡在偏移状态
    this.handlers.bend(0);
    this.handlers.pressure(0);
  }
}
