/**
 * 自定义编曲块回归测试。
 * 用法：node tools/block-tests.mjs
 * 覆盖：外部数据校验、片段转块、新增/覆盖/删除、上限、导出/导入、内置块合并、localStorage 不可用。
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

const mod = await loadTs(join(ROOT, 'src/core/user-blocks.ts'));
const blocksMod = await loadTs(join(ROOT, 'src/core/blocks.ts'));

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

const note = (pitch, start, length, velocity = 0.7, articulation = 'normal') => ({ pitch, start, length, velocity, articulation });

function sample(id, name, extra = {}) {
  return {
    id,
    name,
    category: 'melody',
    style: '自定义',
    key: 'C',
    tempoRange: [60, 160],
    recommendedType: 'synth',
    tags: ['自定义'],
    notes: [note(60, 0, 1), note(64, 1, 1)],
    ...extra,
  };
}

function reset() {
  storage.clear();
}

// ---------------------------------------------------------------- 外部数据校验
{
  const ok = mod.sanitizeBlock(sample('b1', '测试块'));
  check('校验：合法块被保留', !!ok && ok.id === 'b1' && ok.name === '测试块' && ok.category === 'melody');
  check('校验：自定义块带 custom 标记', ok.custom === true);
  check('校验：长度按音符范围推导', ok.beatCount === 2 && ok.bars === 1);

  check('校验：非法分类返回 null', mod.sanitizeBlock(sample('bad', '坏分类', { category: 'solo' })) === null);
  check('校验：空名称返回 null', mod.sanitizeBlock(sample('bad2', '   ')) === null);
  check('校验：空 id 返回 null', mod.sanitizeBlock(sample('', '无 id')) === null);
  check('校验：没有音符返回 null', mod.sanitizeBlock(sample('bad3', '空块', { notes: [] })) === null);
  check('校验：非对象返回 null', mod.sanitizeBlock('nope') === null && mod.sanitizeBlock(null) === null && mod.sanitizeBlock([]) === null);

  const dirty = mod.sanitizeBlock(sample('b2', '脏数据', {
    recommendedType: 'theremin',
    key: '  很长很长的调性  ',
    style: '  ',
    tempoRange: [200, 40],
    tags: ['a', 2, null, 'b', 'c', 'd', 'e', 'f'],
    notes: [
      note(60.6, -1, 0.5),
      note(999, 0, 1),
      note(-3, 0, 1),
      { pitch: 61, start: 0, length: Number.NaN, velocity: 2, articulation: 'weird' },
      { pitch: 'x', start: 0, length: 1 },
      'bad',
    ],
  }));
  check('校验：非法音源类型回落 synth', dirty.recommendedType === 'synth');
  check('校验：调性裁剪长度', dirty.key.length <= 6 && dirty.key.length > 0);
  check('校验：空风格回落「自定义」', dirty.style === '自定义');
  check('校验：速度范围自动排序', dirty.tempoRange[0] === 40 && dirty.tempoRange[1] === 200);
  check('校验：标签最多 6 个字符串', dirty.tags.length === 6 && dirty.tags.every((t) => typeof t === 'string'));
  check('校验：越界音高被过滤', dirty.notes.every((n) => n.pitch >= 0 && n.pitch <= 127));
  check('校验：音高取整', dirty.notes[0].pitch === 61);
  check('校验：负起音归零', dirty.notes[0].start === 0);
  check('校验：坏长度回落且力度/奏法被规范', dirty.notes[1].length > 0 && dirty.notes[1].velocity === 1 && dirty.notes[1].articulation === 'normal');
  check('校验：非法音符条目被丢弃', dirty.notes.length === 2);
}

// ---------------------------------------------------------------- 片段转编曲块
{
  const fromClip = mod.blockFromClipNotes('我的旋律', [
    note(60, 0.5, 1, 0.8),
    note(62, 1.5, 0.5, 0.6, 'mute'),
    note(64, 4.5, 1), // 超出片段长度，应被过滤
  ], 'synth', 4);
  check('片段转块：返回块并保留名称', !!fromClip && fromClip.name === '我的旋律');
  check('片段转块：按片段长度计算小节', fromClip.beatCount === 4 && fromClip.bars === 1);
  check('片段转块：超出片段长度的音符被过滤', fromClip.notes.length === 2);
  check('片段转块：保留小节内相对位置', fromClip.notes[0].start === 0.5 && fromClip.notes[1].start === 1.5);
  check('片段转块：保留力度与奏法', fromClip.notes[1].velocity === 0.6 && fromClip.notes[1].articulation === 'mute');
  check('片段转块：分类由音源类型推导', fromClip.category === 'melody' && fromClip.recommendedType === 'synth');

  const drum = mod.blockFromClipNotes('鼓点', [note(36, 0, 0.2)], 'drum', 2);
  check('片段转块：鼓轨归到「鼓」分类', drum.category === 'drums');
  const bass = mod.blockFromClipNotes('低音', [note(40, 0, 1)], 'bass', 2);
  check('片段转块：贝斯轨归到「贝斯」分类', bass.category === 'bass');

  check('片段转块：空名称返回 null', mod.blockFromClipNotes('   ', [note(60, 0, 1)], 'synth', 4) === null);
  check('片段转块：没有音符返回 null', mod.blockFromClipNotes('空的', [], 'synth', 4) === null);
}

// ---------------------------------------------------------------- 新增 / 覆盖 / 删除
{
  reset();
  mod.addUserBlock(sample('b1', '块 A'));
  mod.addUserBlock(sample('b2', '块 B'));
  check('新增：两块都写入', mod.loadUserBlocks().length === 2);
  check('新增：新保存的排在前面', mod.loadUserBlocks()[0].id === 'b2');

  mod.addUserBlock(sample('b1', '块 A 改'));
  const list = mod.loadUserBlocks();
  check('覆盖：同 ID 原位替换，数量不变', list.length === 2 && list[0].id === 'b2' && list[1].id === 'b1');
  check('覆盖：名称已更新', list[1].name === '块 A 改');

  mod.removeUserBlock('b2');
  check('删除：目标块被移除', mod.loadUserBlocks().length === 1 && mod.loadUserBlocks()[0].id === 'b1');
  mod.removeUserBlock('nope');
  check('删除：不存在的 ID 不报错', mod.loadUserBlocks().length === 1);
}

// ---------------------------------------------------------------- 数量上限
{
  reset();
  for (let i = 0; i < 110; i++) mod.addUserBlock(sample(`m${i}`, `批量 ${i}`));
  check('上限：库存最多 100 条', mod.loadUserBlocks().length === 100);
  reset();
}

// ---------------------------------------------------------------- 导出 / 导入
{
  reset();
  mod.addUserBlock(sample('b1', '导出 A'));
  mod.addUserBlock(sample('b2', '导出 B', { category: 'drums', recommendedType: 'drum', notes: [note(36, 0, 0.2)] }));
  const text = mod.exportUserBlocksJson();
  const parsed = JSON.parse(text);
  check('导出：格式标记正确', parsed.format === 'soundweave-blocks' && parsed.version === 1);
  check('导出：包含全部自定义块', parsed.blocks.length === 2);
  check('导出：音符被完整保留', parsed.blocks.find((b) => b.id === 'b1').notes.length === 2);

  reset();
  const r1 = mod.importUserBlocks(text);
  check('导入：首次全部新增', r1.added === 2 && r1.skipped === 0 && mod.loadUserBlocks().length === 2);
  const r2 = mod.importUserBlocks(text);
  check('导入：同 ID 再次导入全部跳过', r2.added === 0 && r2.skipped === 2 && mod.loadUserBlocks().length === 2);

  const arr = JSON.stringify([sample('b3', '数组形式'), { id: 'bad', name: '', notes: [] }]);
  const r3 = mod.importUserBlocks(arr);
  check('导入：接受纯数组并过滤坏数据', r3.added === 1 && r3.skipped === 1 && mod.loadUserBlocks().length === 3);

  let threw = false;
  try {
    mod.importUserBlocks('{"format":"other"}');
  } catch {
    threw = true;
  }
  check('导入：非编曲块文件抛错', threw);

  threw = false;
  try {
    mod.importUserBlocks('not json');
  } catch {
    threw = true;
  }
  check('导入：非法 JSON 抛错', threw);
}

// ---------------------------------------------------------------- 与内置块的合并
{
  reset();
  check('内置：编曲块数量保持 48', blocksMod.BLOCKS.length === 48);
  mod.addUserBlock(sample('b9', '合并测试', { notes: [note(72, 0, 1), note(76, 1, 1)] }));
  check('合并：allBlocks 包含自定义块', blocksMod.allBlocks().length === 49);
  check('合并：blockById 能查到自定义块', blocksMod.blockById('b9')?.name === '合并测试');
  check('合并：内置块不受影响', blocksMod.blockById('dr-house')?.name === '四拍舞曲');
  check('合并：按分类查询包含自定义块', blocksMod.blocksByCategory('melody').some((b) => b.id === 'b9'));

  const cloned = blocksMod.cloneBlockNotes(blocksMod.blockById('b9'));
  check('插入：自定义块的音符可克隆', cloned.length === 2 && cloned[0].pitch === 72);
  check('插入：克隆音符获得新的 id', cloned[0].id !== 'n_imp' && cloned[0].id !== cloned[1].id);
}

// ---------------------------------------------------------------- 本地存储不可用
{
  reset();
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    check('无存储：读取返回空列表', mod.loadUserBlocks().length === 0);
    mod.saveUserBlocks([sample('x', '无存储')]);
    check('无存储：写入不抛错', true);
    const list = mod.addUserBlock(sample('x', '无存储'));
    check('无存储：新增返回内存列表且不抛错', list.length === 1);
    check('无存储：导出为空库', JSON.parse(mod.exportUserBlocksJson()).blocks.length === 0);
    check('无存储：blockById 仍能查内置块', blocksMod.blockById('dr-house') !== undefined);
  } finally {
    globalThis.localStorage = saved;
  }
}

// ---------------------------------------------------------------- 损坏的存储内容
{
  reset();
  storage.setItem('soundweave.blocks.v1', '{broken');
  check('损坏存储：读取返回空列表而不是崩溃', mod.loadUserBlocks().length === 0);
  storage.setItem('soundweave.blocks.v1', '"text"');
  check('损坏存储：非数组内容被忽略', mod.loadUserBlocks().length === 0);
  storage.setItem('soundweave.blocks.v1', JSON.stringify([sample('ok', '好的'), { id: 'bad', name: '', notes: [] }]));
  check('损坏存储：逐条校验时丢弃坏条目', mod.loadUserBlocks().length === 1 && mod.loadUserBlocks()[0].id === 'ok');
  reset();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
