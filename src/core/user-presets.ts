/**
 * 自定义音色的本地持久化（localStorage）与导入导出。
 * 与内置预设分开存放，工程里只保存 presetId；音色库丢失时工程参数仍在，音色不会变。
 */
import type { InstrumentType, Preset, PresetFx, PresetMacro } from './types';

const KEY = 'soundweave.presets.v1';
const MAX = 120;

const TYPES: InstrumentType[] = ['ep', 'piano', 'guitar', 'synth', 'bass', 'drum'];
const FX_KEYS = ['volume', 'pan', 'sendReverb', 'sendDelay', 'tone', 'drive', 'chorus'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function numbers(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function macros(raw: unknown): PresetMacro[] {
  if (!Array.isArray(raw)) return [];
  const out: PresetMacro[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
    if (!Array.isArray(item.targets)) continue;
    const targets = item.targets
      .filter((t): t is Record<string, unknown> => isRecord(t))
      .filter((t) => typeof t.min === 'number' && typeof t.max === 'number')
      .map((t) => ({
        ...(typeof t.param === 'string' ? { param: t.param } : {}),
        ...(typeof t.fx === 'string' ? { fx: t.fx as PresetMacro['targets'][number]['fx'] } : {}),
        min: t.min as number,
        max: t.max as number,
      }));
    if (targets.length) out.push({ id: item.id, name: item.name, targets });
  }
  return out;
}

function fx(raw: unknown): PresetFx | undefined {
  if (!isRecord(raw)) return undefined;
  const out: PresetFx = {};
  let any = false;
  for (const key of FX_KEYS) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** 校验并补全一个外部来源的预设；不合法时返回 null */
export function sanitizePreset(raw: unknown): Preset | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const type = raw.type as InstrumentType;
  if (!id || !name || !TYPES.includes(type)) return null;
  const params = numbers(raw.params);
  if (!Object.keys(params).length) return null;
  return {
    id,
    name,
    category: typeof raw.category === 'string' && raw.category ? raw.category : '我的音色',
    type,
    description: typeof raw.description === 'string' ? raw.description : '自定义音色',
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 6)
      : ['自定义'],
    params,
    macros: macros(raw.macros),
    usage: typeof raw.usage === 'string' ? raw.usage : undefined,
    fx: fx(raw.fx),
    custom: raw.custom !== false,
  };
}

export function loadUserPresets(): Preset[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizePreset).filter((p): p is Preset => !!p).slice(0, MAX);
  } catch {
    return [];
  }
}

export function saveUserPresets(list: Preset[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 配额不足时保持内存中的列表可用，不阻断编辑 */
  }
}

/** 新增或按 id 覆盖，返回保存后的完整列表 */
export function addUserPreset(preset: Preset): Preset[] {
  const list = loadUserPresets();
  const index = list.findIndex((p) => p.id === preset.id);
  if (index >= 0) list[index] = preset;
  else list.unshift(preset);
  saveUserPresets(list);
  return list.slice(0, MAX);
}

export function removeUserPreset(id: string): Preset[] {
  const list = loadUserPresets().filter((p) => p.id !== id);
  saveUserPresets(list);
  return list;
}

export function exportUserPresetsJson(): string {
  const presets = loadUserPresets();
  return JSON.stringify({ format: 'soundweave-presets', version: 1, presets }, null, 2);
}

/** 导入音色库：已存在的 id 跳过，返回新增数量 */
export function importUserPresets(text: string): { added: number; skipped: number } {
  const parsed = JSON.parse(text);
  const incoming = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.presets)
      ? parsed.presets
      : null;
  if (!incoming) throw new Error('不是 SoundWeave 音色库文件');
  const list = loadUserPresets();
  const ids = new Set(list.map((p) => p.id));
  let added = 0;
  let skipped = 0;
  for (const raw of incoming) {
    const preset = sanitizePreset(raw);
    if (!preset) {
      skipped++;
      continue;
    }
    if (ids.has(preset.id)) {
      skipped++;
      continue;
    }
    ids.add(preset.id);
    list.unshift(preset);
    added++;
  }
  saveUserPresets(list);
  return { added, skipped };
}
