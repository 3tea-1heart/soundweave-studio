/**
 * studio-processor.js 的类型声明（该文件是纯 JS，同时供 AudioWorklet 与 Node 离线渲染加载，
 * 不参与 TypeScript 编译；这里仅为 render.ts 的 Node 离线渲染提供类型入口）。
 */
export class StudioProcessor {
  constructor(options?: { sampleRate?: number; post?: (msg: Record<string, unknown>) => void });
  receive(msg: Record<string, unknown>): void;
  processBlock(outChannels: Float32Array[]): void;
  postMessage(msg: Record<string, unknown>): void;
}

export function defaultParams(type: string): Record<string, number>;

export const TYPE_DEFAULTS: Record<string, Record<string, number>>;
export const DRUM_MAP: Record<number, string>;
export const MAX_TRACKS: number;

export function mtof(m: number): number;