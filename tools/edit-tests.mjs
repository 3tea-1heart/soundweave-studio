/**
 * 音符与自动化编辑的纯函数回归测试。
 * 用法：node tools/edit-tests.mjs
 * 覆盖钢琴卷帘的框选/复制粘贴、力度、微调，以及自动化点的新增/移动/删除与求值。
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

const noteEdit = await loadTs(join(ROOT, 'src/core/note-edit.ts'));
const auto = await loadTs(join(ROOT, 'src/core/automation.ts'));

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

function note(id, pitch, start, length, velocity = 0.8) {
  return { id, pitch, start, length, velocity, articulation: 'normal' };
}

// ---------------------------------------------------------------- 框选
{
  const notes = [
    note('a', 60, 0, 1),
    note('b', 64, 2, 1),
    note('c', 72, 4, 2),
    note('d', 60, 6, 1),
  ];
  const picked = noteEdit.notesInRect(notes, 1.5, 5.5, 58, 68);
  check('框选：按时间与音高交集选中', picked.map((n) => n.id).join(',') === 'b', picked.map((n) => n.id).join(','));
  const boundary = noteEdit.notesInRect(notes, 2, 3, 63, 65);
  check('框选：矩形边界内选中', boundary.length === 1 && boundary[0].id === 'b');
  const covering = noteEdit.notesInRect(notes, 0.5, 1.5, 59, 61);
  check('框选：跨越矩形起点的长音符被选中', covering.length === 1 && covering[0].id === 'a');
}

// ---------------------------------------------------------------- 复制粘贴
{
  const notes = [note('a', 60, 2, 1), note('b', 64, 3, 0.5), note('c', 67, 5, 1)];
  let seq = 0;
  const pasted = noteEdit.pasteNotes(notes, 4, 8, () => `p${++seq}`);
  check('粘贴：以最早音符对齐目标拍', pasted[0].start === 4 && pasted[1].start === 5 && pasted[2].start === 7);
  check('粘贴：保持相对间距与音高', pasted[1].pitch === 64 && Math.abs(pasted[2].start - pasted[0].start - 3) < 1e-9);
  check('粘贴：生成唯一新 ID', new Set(pasted.map((n) => n.id)).size === 3 && !pasted[0].id.startsWith('n_'));
  check('粘贴：不修改剪贴板内容', notes[0].start === 2 && notes[2].start === 5);
  const clamped = noteEdit.pasteNotes(notes, 20, 8, () => `q${++seq}`);
  check('粘贴：不越过片段结尾', clamped.every((n) => n.start <= 7.9375), clamped.map((n) => n.start).join(','));
  const atZero = noteEdit.pasteNotes([note('z', 60, 8, 1)], 0, 8, () => 'z1');
  check('粘贴：目标为负时裁到 0', atZero[0].start === 0);
}

// ---------------------------------------------------------------- 力度 / 删除 / 微调
{
  const notes = [note('a', 60, 1, 1, 0.4), note('b', 61, 2, 1, 0.9)];
  const n = noteEdit.setNotesVelocity(notes, 1.4);
  check('力度：批量设置并裁剪到 1', n === 2 && notes.every((x) => x.velocity === 1));
  noteEdit.setNotesVelocity(notes, 0.01);
  check('力度：下限裁剪到 0.05', notes.every((x) => x.velocity === 0.05));
  const removed = noteEdit.removeNotesById(notes, new Set(['a']));
  check('删除：按 ID 删除', removed.length === 1 && removed[0].id === 'b');
  const nudged = [note('a', 60, 0.5, 1), note('b', 64, 2, 1)];
  noteEdit.nudgeNotes(nudged, -0.25, 1);
  check('微调：拍不越界且音高平移', nudged[0].start === 0.25 && nudged[1].start === 1.75 && nudged[0].pitch === 61);
  noteEdit.nudgeNotes(nudged, 0, 200);
  check('微调：音高上限 108', nudged.every((x) => x.pitch === 108));
}

// ---------------------------------------------------------------- 自动化点
function trackFixture() {
  return {
    id: 't1',
    name: '测试',
    color: '#fff',
    instrument: { presetId: 'ep-warm', type: 'ep', params: { index: 2, tone: 0.8 } },
    volume: 0.5,
    pan: 0,
    mute: false,
    solo: false,
    sendReverb: 0.2,
    sendDelay: 0,
    tone: 0.9,
    drive: 0.05,
    chorus: 0,
    automation: [],
  };
}

{
  const t = trackFixture();
  const lane = { paramId: 'param:index', points: [] };
  t.automation.push(lane);
  const p1 = auto.upsertLanePoint(lane, 1, 2.5, 0.125, auto.automationRange(t, lane.paramId));
  const p2 = auto.upsertLanePoint(lane, 1.05, 4.9, 0.125, auto.automationRange(t, lane.paramId));
  check('自动化：邻近点更新而非重复', lane.points.length === 1 && p1 === p2 && Math.abs(p1.value - 4.9) < 1e-9);
  const p3 = auto.upsertLanePoint(lane, 3, 0.3, 0.125, auto.automationRange(t, lane.paramId));
  auto.upsertLanePoint(lane, 2, 1.0, 0.125);
  check('自动化：插入后按拍排序', lane.points.map((p) => p.beat).join(',') === '1.05,2,3', lane.points.map((p) => p.beat).join(','));
  check('自动化：参数范围来自音源定义', auto.automationRange(t, 'param:index').max === 5);
  check('自动化：效果范围', auto.automationRange(t, 'fx:sendReverb').max === 1 && auto.automationRange(t, 'fx:pan').min === -1);

  auto.moveLanePoint(lane, p3, -2, 99, auto.automationRange(t, lane.paramId));
  check('自动化：移动点裁剪拍与值', p3.beat === 0 && p3.value === 5);
  auto.sortLanePoints(lane);
  check('自动化：排序后第一个是移动过的点', lane.points[0].beat === 0);

  const removed = auto.removeLanePointNear(lane, 0, 5, 0.2, 0.1);
  check('自动化：删除控制点', removed && lane.points.length === 2);
  const miss = auto.removeLanePointNear(lane, 10, 0, 0.1, 0.1);
  check('自动化：远处点不会被误删', !miss && lane.points.length === 2);
  const probe = { paramId: 'fx:sendReverb', points: [{ beat: 0, value: 0 }, { beat: 2, value: 10 }] };
  check('自动化：laneValue 线性插值', auto.laneValue(probe, 1, 0) === 5 && auto.laneValue(probe, 3, 0) === 10);
  check('自动化：空 lane 使用静态值', auto.automationStaticValue(t, 'param:index') === 2);
  check('自动化：controlAt 合并 lane 值', auto.controlAt(t, 2).params.index === lane.points[1].value);
}

// ---------------------------------------------------------------- 手绘曲线
{
  const t = trackFixture();
  const lane = { paramId: 'fx:sendReverb', points: [] };
  for (let i = 0; i <= 8; i++) auto.upsertLanePoint(lane, i * 0.5, i / 8, 0.06, auto.automationRange(t, lane.paramId));
  check('手绘：连续点按拍排序', lane.points.length === 9 && lane.points[8].beat === 4);
  check('手绘：中点插值单调', auto.laneValue(lane, 2, 0) > auto.laneValue(lane, 1, 0));
  const overwritten = auto.removeLanePointsInRange(lane, 0.9, 2.1);
  check(
    '手绘：覆盖区间旧点被清除',
    overwritten === 3 && lane.points.length === 6 && !lane.points.some((p) => p.beat > 0.9 && p.beat < 2.1),
    `${overwritten} removed / ${lane.points.length} left`,
  );
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
