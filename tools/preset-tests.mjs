/**
 * 自定义音色库回归测试。
 * 用法：node tools/preset-tests.mjs
 * 覆盖：外部数据校验、新增/覆盖、删除、导出、导入（同 ID 跳过/坏数据过滤）、localStorage 不可用。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function loadTs(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(url);
}

const storage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
  removeItem(key) {
    this.store.delete(key);
  },
  clear() {
    this.store.clear();
  },
};

globalThis.localStorage = storage;

const mod = await loadTs(join(ROOT, 'src/core/user-presets.ts'));
const presetsMod = await loadTs(join(ROOT, 'src/core/presets.ts'));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sample(id, name, extra = {}) {
  return {
    id,
    name,
    category: '我的音色',
    type: 'ep',
    description: '测试音色',
    tags: ['自定义'],
    params: { index: 2.2, tine: 0.4 },
    macros: [],
    ...extra,
  };
}

function reset() {
  storage.clear();
}

// ---------------------------------------------------------------- 外部数据校验
{
  const ok = mod.sanitizePreset(sample('u1', '测试'));
  check('校验：合法预设被保留', !!ok && ok.id === 'u1' && ok.name === '测试' && ok.type === 'ep');
  check('校验：自定义预设默认 custom=true', ok.custom === true);
  check('校验：缺少 category 时归到「我的音色」', mod.sanitizePreset({ ...sample('u2', '无分类'), category: undefined }).category === '我的音色');

  check('校验：类型非法返回 null', mod.sanitizePreset(sample('bad', '坏类型', { type: 'theremin' })) === null);
  check('校验：空名称返回 null', mod.sanitizePreset(sample('bad2', '   ')) === null);
  check('校验：空 id 返回 null', mod.sanitizePreset(sample('', '无 id')) === null);
  check('校验：无参数返回 null', mod.sanitizePreset(sample('bad3', '无参数', { params: {} })) === null);
  check('校验：非对象返回 null', mod.sanitizePreset('nope') === null && mod.sanitizePreset(null) === null && mod.sanitizePreset([]) === null);

  const dirty = mod.sanitizePreset(sample('u3', '脏数据', {
    params: { index: 2, bad: 'x', nan: Number.NaN, inf: Number.POSITIVE_INFINITY },
    fx: { volume: 0.6, pan: -0.3, tone: 'x', drive: Number.NaN },
    tags: ['a', 2, null, 'b', 'c', 'd', 'e', 'f', 'g'],
  }));
  check('校验：参数只保留有限数字', dirty.params.index === 2 && !('bad' in dirty.params) && !('nan' in dirty.params) && !('inf' in dirty.params));
  check('校验：效果只保留有限数字', dirty.fx.volume === 0.6 && dirty.fx.pan === -0.3 && !('tone' in dirty.fx) && !('drive' in dirty.fx));
  check('校验：标签裁剪为 6 个字符串', dirty.tags.length === 6 && dirty.tags.every((t) => typeof t === 'string'));

  const noFx = mod.sanitizePreset(sample('u4', '无效果', { fx: { drive: Number.NaN } }));
  check('校验：没有有效效果字段时 fx 不保留', noFx.fx === undefined);
}

// ---------------------------------------------------------------- 新增 / 覆盖 / 删除
{
  reset();
  const a = sample('u1', '音色 A');
  mod.addUserPreset(a);
  mod.addUserPreset(sample('u2', '音色 B'));
  check('新增：两条音色都写入', mod.loadUserPresets().length === 2);
  check('新增：新保存的排在前面', mod.loadUserPresets()[0].id === 'u2');

  mod.addUserPreset(sample('u1', '音色 A 改'));
  const list = mod.loadUserPresets();
  check('覆盖：同 ID 原位替换，数量不变', list.length === 2 && list[0].id === 'u2' && list[1].id === 'u1');
  check('覆盖：名称已更新', list[1].name === '音色 A 改');

  mod.removeUserPreset('u2');
  check('删除：目标音色被移除', mod.loadUserPresets().length === 1 && mod.loadUserPresets()[0].id === 'u1');
  mod.removeUserPreset('nope');
  check('删除：不存在的 ID 不报错', mod.loadUserPresets().length === 1);
}

// ---------------------------------------------------------------- 数量上限
{
  reset();
  for (let i = 0; i < 130; i++) mod.addUserPreset(sample(`m${i}`, `批量 ${i}`));
  check('上限：库存最多 120 条', mod.loadUserPresets().length === 120);
  reset();
}

// ---------------------------------------------------------------- 导出 / 导入
{
  reset();
  mod.addUserPreset(sample('u1', '导出 A', { fx: { volume: 0.7, tone: 0.8 } }));
  mod.addUserPreset(sample('u2', '导出 B'));
  const text = mod.exportUserPresetsJson();
  const parsed = JSON.parse(text);
  check('导出：格式标记正确', parsed.format === 'soundweave-presets' && parsed.version === 1);
  check('导出：包含全部自定义音色', parsed.presets.length === 2);
  check('导出：效果快照被保留', parsed.presets.find((p) => p.id === 'u1').fx.volume === 0.7);

  reset();
  const r1 = mod.importUserPresets(text);
  check('导入：首次全部新增', r1.added === 2 && r1.skipped === 0 && mod.loadUserPresets().length === 2);
  const r2 = mod.importUserPresets(text);
  check('导入：同 ID 再次导入全部跳过', r2.added === 0 && r2.skipped === 2 && mod.loadUserPresets().length === 2);

  const arr = JSON.stringify([sample('u3', '数组形式'), { id: 'bad', name: '', params: {} }]);
  const r3 = mod.importUserPresets(arr);
  check('导入：接受纯数组形式并过滤坏数据', r3.added === 1 && r3.skipped === 1 && mod.loadUserPresets().length === 3);

  let threw = false;
  try {
    mod.importUserPresets('{"format":"other"}');
  } catch {
    threw = true;
  }
  check('导入：非音色库文件抛错', threw);

  threw = false;
  try {
    mod.importUserPresets('not json');
  } catch {
    threw = true;
  }
  check('导入：非法 JSON 抛错', threw);
}

// ---------------------------------------------------------------- 与内置预设的合并
{
  reset();
  check('内置：预设数量保持 64', presetsMod.PRESETS.length === 64);
  check('内置：分类包含「我的音色」', presetsMod.PRESET_CATEGORIES.includes('我的音色'));

  mod.addUserPreset(sample('u9', '合并测试', { type: 'synth', params: { cutoff: 900, resonance: 0.4 } }));
  check('合并：allPresets 包含自定义音色', presetsMod.allPresets().length === 65);
  check('合并：presetById 能查到自定义音色', presetsMod.presetById('u9')?.name === '合并测试');
  check('合并：用户音色带 custom 标记', presetsMod.presetById('u9')?.custom === true);
  check('合并：内置音色不受影响', presetsMod.presetById('ep-warm')?.name === '暖电钢');
  check('合并：userPresets 只返回自定义', presetsMod.userPresets().length === 1);
}

// ---------------------------------------------------------------- 本地存储不可用
{
  reset();
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    check('无存储：读取返回空列表', mod.loadUserPresets().length === 0);
    mod.saveUserPresets([sample('x', '无存储')]);
    check('无存储：写入不抛错', true);
    const list = mod.addUserPreset(sample('x', '无存储'));
    check('无存储：新增返回内存列表且不抛错', list.length === 1);
    check('无存储：导出为空库', JSON.parse(mod.exportUserPresetsJson()).presets.length === 0);
  } finally {
    globalThis.localStorage = saved;
  }
}

// ---------------------------------------------------------------- 损坏的存储内容
{
  reset();
  storage.setItem('soundweave.presets.v1', '{broken');
  check('损坏存储：读取返回空列表而不是崩溃', mod.loadUserPresets().length === 0);
  storage.setItem('soundweave.presets.v1', '"text"');
  check('损坏存储：非数组内容被忽略', mod.loadUserPresets().length === 0);
  storage.setItem('soundweave.presets.v1', JSON.stringify([sample('ok', '好的'), { id: 'bad', type: 'x', params: {} }]));
  check('损坏存储：逐条校验时丢弃坏条目', mod.loadUserPresets().length === 1 && mod.loadUserPresets()[0].id === 'ok');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
