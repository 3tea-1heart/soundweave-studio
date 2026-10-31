/**
 * 自定义编曲块的本地持久化（localStorage）与导入导出。
 * 与内置 48 块分开存放；工程里只保存片段音符，块库丢失不会改变已有编排。
 */
import type { Articulation, InstrumentType, MusicBlock, Note } from './types';

const KEY = 'soundweave.blocks.v1';
const MAX = 100;

const CATEGORIES: MusicBlock['category'][] = ['chords', 'melody', 'bass', 'drums', 'fill'];
const TYPES: InstrumentType[] = ['ep', 'piano', 'guitar', 'synth', 'bass', 'drum'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function cleanNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const out: Note[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const pitch = Math.round(finite(item.pitch, Number.NaN));
    if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127) continue;
    const start = Math.max(0, finite(item.start, 0));
    const length = Math.max(0.01, finite(item.length, 0.25));
    const velocity = Math.min(1, Math.max(0.05, finite(item.velocity, 0.7)));
    const articulation: Articulation = item.articulation === 'mute' ? 'mute' : 'normal';
    out.push({ id: 'n_imp', pitch, start, length, velocity, articulation });
  }
  return out;
}

/** 音符最大结束拍，至少 1 拍 */
function noteExtent(notes: Note[]): number {
  return notes.reduce((m, n) => Math.max(m, n.start + n.length), 0);
}

/** 校验并补全一个外部来源的编曲块；不合法时返回 null */
export function sanitizeBlock(raw: unknown): MusicBlock | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) return null;
  const category = raw.category as MusicBlock['category'];
  if (!CATEGORIES.includes(category)) return null;
  const notes = cleanNotes(raw.notes);
  if (!notes.length) return null;
  const recommendedType = raw.recommendedType as InstrumentType;
  const type = TYPES.includes(recommendedType) ? recommendedType : 'synth';
  // 块长度由音符实际范围决定，避免外部文件里 beatCount 与音符不一致
  const beatCount = Math.max(1, Math.ceil(noteExtent(notes) * 4 - 1e-6) / 4);
  const range = raw.tempoRange;
  const lo = Array.isArray(range) ? finite(range[0], 60) : 60;
  const hi = Array.isArray(range) ? finite(range[1], 160) : 160;
  return {
    id,
    name,
    category,
    bars: Math.max(1, Math.ceil(beatCount / 4)),
    beatCount,
    key: typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim().slice(0, 6) : 'C',
    style: typeof raw.style === 'string' && raw.style.trim() ? raw.style.trim().slice(0, 20) : '自定义',
    tempoRange: [Math.min(lo, hi), Math.max(lo, hi)],
    recommendedType: type,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 6)
      : ['自定义'],
    notes,
    custom: true,
  };
}

export function loadUserBlocks(): MusicBlock[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeBlock).filter((b): b is MusicBlock => !!b).slice(0, MAX);
  } catch {
    return [];
  }
}

export function saveUserBlocks(list: MusicBlock[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 配额不足时保持内存列表可用，不阻断编辑 */
  }
}

/** 新增或按 id 覆盖，返回保存后的完整列表 */
export function addUserBlock(block: MusicBlock): MusicBlock[] {
  const list = loadUserBlocks();
  const index = list.findIndex((b) => b.id === block.id);
  if (index >= 0) list[index] = block;
  else list.unshift(block);
  saveUserBlocks(list);
  return list.slice(0, MAX);
}

export function removeUserBlock(id: string): MusicBlock[] {
  const list = loadUserBlocks().filter((b) => b.id !== id);
  saveUserBlocks(list);
  return list;
}

export function exportUserBlocksJson(): string {
  const blocks = loadUserBlocks();
  return JSON.stringify({ format: 'soundweave-blocks', version: 1, blocks }, null, 2);
}

/** 导入编曲块库：已存在的 id 跳过，返回新增数量 */
export function importUserBlocks(text: string): { added: number; skipped: number } {
  const parsed = JSON.parse(text);
  const incoming = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.blocks)
      ? parsed.blocks
      : null;
  if (!incoming) throw new Error('不是 SoundWeave 编曲块文件');
  const list = loadUserBlocks();
  const ids = new Set(list.map((b) => b.id));
  let added = 0;
  let skipped = 0;
  for (const raw of incoming) {
    const block = sanitizeBlock(raw);
    if (!block || ids.has(block.id)) {
      skipped++;
      continue;
    }
    ids.add(block.id);
    list.unshift(block);
    added++;
  }
  saveUserBlocks(list);
  return { added, skipped };
}

/** 由片段音符生成可保存的编曲块（起音归零、按实际长度裁剪） */
export function blockFromClipNotes(
  name: string,
  notes: Note[],
  type: InstrumentType,
  length: number,
): MusicBlock | null {
  const clean = name.trim().slice(0, 40);
  if (!clean) return null;
  const beatCount = Math.max(1, Math.ceil((Number.isFinite(length) && length > 0 ? length : noteExtent(notes)) * 4) / 4);
  const inner = notes
    .filter((n) => n.start >= 0 && n.start < beatCount)
    .map((n) => ({
      id: n.id,
      pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
      start: Math.max(0, n.start),
      length: Math.max(0.01, Math.min(n.length, beatCount - n.start)),
      velocity: Math.min(1, Math.max(0.05, n.velocity)),
      articulation: n.articulation,
    }));
  if (!inner.length) return null;
  const category: MusicBlock['category'] = type === 'drum' ? 'drums' : type === 'bass' ? 'bass' : 'melody';
  return {
    id: `user-block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    category,
    bars: Math.max(1, Math.ceil(beatCount / 4)),
    beatCount,
    key: 'C',
    style: '自定义',
    tempoRange: [60, 160],
    recommendedType: type,
    tags: ['自定义'],
    notes: inner,
    custom: true,
  };
}
