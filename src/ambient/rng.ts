/**
 * 确定性伪随机数生成器。
 * 同一 seed 始终产生相同序列；生成 worker 与单元测试共享本实现，
 * 直接支撑「固定 seed 可复现」这一验收项。
 */

/** xmur3：把任意字符串/数字压缩为 32-bit 无符号种子 */
export function hashSeed(seed: string | number): number {
  const s = typeof seed === 'number' ? String(seed >>> 0) : String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 规范化 seed 为字符串（用于追溯与序列化） */
export function seedString(seed: string | number): string {
  return typeof seed === 'number' ? String(seed >>> 0) : String(seed);
}

export class Rng {
  private state: number;

  constructor(seed: string | number = 'soundweave') {
    this.state = hashSeed(seed);
    for (let i = 0; i < 3; i++) this.next();
  }

  /** 导出内部 32-bit 状态（用于 checkpoint/resume） */
  getState(): number {
    return this.state >>> 0;
  }

  /** 恢复内部状态（用于 checkpoint/resume） */
  setState(state: number): void {
    this.state = state >>> 0;
  }

  /** [0, 1) 均匀分布 */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number {
    return Math.floor(this.uniform(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of items) total += Math.max(0, w);
    if (total <= 0) return items[0][0];
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= Math.max(0, w);
      if (r <= 0) return v;
    }
    return items[items.length - 1][0];
  }

  gaussian(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 派生子流：不同 Agent / 不同阶段各用一条，避免共享序列导致相关。 */
  fork(tag: string): Rng {
    return new Rng(`${this.state.toString(36)}:${tag}`);
  }
}