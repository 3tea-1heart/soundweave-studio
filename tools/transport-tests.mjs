/**
 * v0.2.2 播放与导出正确性回归测试（Node，无需浏览器）。
 * 用法：node tools/transport-tests.mjs
 *
 * 覆盖：长音重触发、循环时间与漂移、非零循环起点、后台跳时、
 * 停止/跳转取消未来事件、试听与工程播放隔离、节拍器拍号与起点、
 * 变速不跳拍、离线 solo/分轨规则、实时与离线自动化一致、lane 删除恢复。
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { StudioProcessor } from '../src/audio/studio-processor.js';

const results = [];
async function record(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true, detail: '' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
    console.log(`FAIL  ${name}\n        ${err && err.message ? err.message : String(err)}`);
  }
}

async function loadTs(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  const url = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(url);
}

globalThis.window = { setInterval: () => 1, clearInterval: () => {} };

// ---------------------------------------------------------------- helpers
function makeTrack(i) {
  return {
    id: `t${i}`, name: `T${i}`, color: '#7aa2ff',
    instrument: { presetId: 'synth', type: 'synth', params: {} },
    volume: 0.85, pan: 0, mute: false, solo: false,
    sendReverb: 0.18, sendDelay: 0, tone: 0.9, drive: 0.04, chorus: 0,
    automation: [],
  };
}

function makeProject(opts = {}) {
  const tempo = opts.tempo ?? 120;
  const timeSig = opts.timeSig ?? [4, 4];
  const loop = opts.loop ?? { enabled: false, start: 0, end: 4 };
  const tracks = Array.from({ length: opts.tracks ?? 1 }, (_, i) => makeTrack(i));
  const clips = [];
  let index = 0;
  for (const c of opts.clips ?? []) {
    clips.push({
      id: c.id ?? `c${index}`, trackId: c.trackId ?? 't0', name: c.name ?? 'clip',
      start: c.start, length: c.length, offset: 0, transpose: 0,
      notes: c.notes.map((n) => ({
        id: n.id ?? `n${index}_${n.start}_${n.pitch}`,
        pitch: n.pitch, start: n.start, length: n.length,
        velocity: n.velocity ?? 0.7, articulation: n.articulation ?? 'normal',
      })),
    });
    index++;
  }
  return {
    version: 1, id: 'p', name: 'test', tempo, timeSig, loop, tracks, clips,
    master: { volume: 0.9 }, createdAt: '', updatedAt: '',
  };
}

function harness(project) {
  const log = [];
  const engine = {
    ctx: { currentTime: 0 },
    ensure: async () => {},
    note(...args) { log.push({ type: 'note', args }); },
    noteOff(...args) { log.push({ type: 'noteOff', args }); },
    allNotesOff() { log.push({ type: 'allNotesOff' }); },
    metronome(when, accent) { log.push({ type: 'click', when, accent }); },
    post(msg) { log.push({ type: 'post', msg }); },
    resetSource(src, gen) { log.push({ type: 'resetSource', src, gen }); },
  };
  return { log, engine, project };
}

function notesOf(log) {
  return log.filter((e) => e.type === 'note').map((e) => {
    const a = e.args;
    return { track: a[0], pitch: a[1], velocity: a[2], when: a[3], dur: a[4], id: a[5], art: a[6], meta: a[7] };
  });
}

function clicksOf(log) {
  return log.filter((e) => e.type === 'click').map((e) => ({ when: e.when, accent: e.accent }));
}

function simulate(h, s, fromSec, toSec, stepMs = 25) {
  for (let ms = Math.round(fromSec * 1000); ms <= Math.round(toSec * 1000); ms += stepMs) {
    h.engine.ctx.currentTime = ms / 1000;
    s.tick();
  }
}

function setMetronome(s, on) {
  if (typeof s.setMetronome === 'function') s.setMetronome(on);
  else s.metronome = on;
}

function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

/** 处理器消息在 processBlock 中才生效，测试需手动推进一个 block */
function pump(sp) {
  sp.processBlock([new Float32Array(128), new Float32Array(128)]);
}

// ---------------------------------------------------------------- load code
let Scheduler = null;
try {
  ({ Scheduler } = await loadTs('src/core/scheduler.ts'));
} catch (err) {
  console.log(`WARN  无法加载 scheduler.ts：${err.message}`);
}

let session = null;
try {
  session = await loadTs('src/core/session.ts');
} catch (err) {
  console.log(`WARN  无法加载 session.ts：${err.message}`);
}

// ---------------------------------------------------------------- 1. 长音
await record('长音：120 BPM 4 拍持续音在 1 秒内只起音一次', async () => {
  assert.ok(Scheduler, 'Scheduler 未加载');
  const project = makeProject({ clips: [{ start: 0, length: 4, notes: [{ pitch: 60, start: 0, length: 4 }] }] });
  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(0);
  simulate(h, s, 0.06, 1.0);
  const notes = notesOf(h.log);
  assert.equal(notes.length, 1, `期望 1 次起音，实际 ${notes.length} 次（修复前约 41 次）`);
  assert.ok(near(notes[0].when, 0.06, 0.02), `起音时间应约为 0.06s，实际 ${notes[0].when}`);
  assert.ok(near(notes[0].dur, 2.0, 0.02), `音符时值应为 2 秒，实际 ${notes[0].dur}`);
});

// ---------------------------------------------------------------- 2. 循环
await record('循环：120 BPM 0—4 拍循环 20 轮，2 秒回绕且不漂移', async () => {
  assert.ok(Scheduler, 'Scheduler 未加载');
  const project = makeProject({
    loop: { enabled: true, start: 0, end: 4 },
    clips: [{ start: 0, length: 4, notes: [{ pitch: 60, start: 0, length: 4 }] }],
  });
  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(0);
  simulate(h, s, 0.06, 39.9);
  const notes = notesOf(h.log);
  assert.ok(notes.length >= 20, `20 轮应至少 20 次起音，实际 ${notes.length}`);
  notes.slice(0, 20).forEach((n, k) => {
    assert.ok(near(n.when, 0.06 + k * 2.0, 0.03), `第 ${k + 1} 轮应在 ${(0.06 + k * 2).toFixed(3)}s，实际 ${n.when.toFixed(3)}s`);
    assert.ok(near(n.dur, 2.0, 0.03), `第 ${k + 1} 轮时值应为 2 秒，实际 ${n.dur.toFixed(3)}s`);
  });
  const ids = new Set(notes.map((n) => n.id));
  assert.ok(ids.size >= 20, '每轮实例键必须唯一');
});

// ---------------------------------------------------------------- 3. 非零起点
await record('循环：非零起点 2—6 拍循环 20 轮对齐', async () => {
  assert.ok(Scheduler, 'Scheduler 未加载');
  const project = makeProject({
    loop: { enabled: true, start: 2, end: 6 },
    clips: [{ start: 2, length: 4, notes: [{ pitch: 60, start: 0, length: 4 }] }],
  });
  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(2);
  simulate(h, s, 0.06, 39.9);
  const notes = notesOf(h.log);
  assert.ok(notes.length >= 20, `20 轮应至少 20 次起音，实际 ${notes.length}`);
  notes.slice(0, 20).forEach((n, k) => {
    assert.ok(near(n.when, 0.06 + k * 2.0, 0.03), `第 ${k + 1} 轮应在 ${(0.06 + k * 2).toFixed(3)}s，实际 ${n.when.toFixed(3)}s`);
  });
});

// ---------------------------------------------------------------- 4. 后台跳时
await record('后台恢复：计时器停顿 5 秒后不补发过期事件', async () => {
  assert.ok(Scheduler, 'Scheduler 未加载');
  const project = makeProject({
    loop: { enabled: true, start: 0, end: 4 },
    clips: [{
      start: 0,
      length: 8,
      notes: [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ pitch: 60, start: b, length: 1 })),
    }],
  });
  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(0);
  simulate(h, s, 0.06, 0.3);
  h.engine.ctx.currentTime = 5.2;
  s.tick();
  // 播放锚点含 0.06s 预滚：5.2s 已播放 5.14s / 0.5s = 10.28 拍，4 拍循环后为 2.28 拍
  assert.ok(near(s.position, 2.28, 0.02), `5.2s 应位于循环第 2.28 拍，实际 ${s.position.toFixed(3)}`);
  const upcoming = notesOf(h.log).filter((n) => n.when >= 5.19);
  upcoming.forEach((n) => assert.ok(n.when >= 5.19, '不应排入过去时刻的音符'));
  assert.ok(h.log.some((e) => e.type === 'resetSource' && e.src === 'transport'), '跳时应取消旧的运输事件');
});

// ---------------------------------------------------------------- 5. 处理器取消
await record('停止：resetSource 丢弃已排队的未来运输事件', () => {
  const sp = new StudioProcessor({ sampleRate: 48000 });
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: 0.5, when: 1, dur: 1, id: 'future', src: 'transport', gen: 1 });
  pump(sp);
  assert.equal(sp.events.length, 1, '前置：未来事件应已入队');
  sp.receive({ type: 'resetSource', src: 'transport', gen: 2 });
  pump(sp);
  assert.equal(sp.events.length, 0, '停止后旧运输事件必须清空');
});

await record('试听隔离：resetSource preview 不取消工程播放事件', () => {
  const sp = new StudioProcessor({ sampleRate: 48000 });
  sp.receive({ type: 'note', track: 15, pitch: 60, velocity: 0.5, when: 1, dur: 1, id: 'pv', src: 'preview', gen: 1 });
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: 0.5, when: 1, dur: 1, id: 'proj', src: 'transport', gen: 1 });
  pump(sp);
  assert.equal(sp.events.length, 2, '前置：两个未来事件应已入队');
  sp.receive({ type: 'resetSource', src: 'preview', gen: 2 });
  pump(sp);
  assert.equal(sp.events.length, 1, '新的试听会话应只清理旧试听事件');
  assert.equal(sp.events[0].src, 'transport', '工程运输事件必须保留');
});

await record('实时键盘：transport 重置不清除 live 来源事件', () => {
  const sp = new StudioProcessor({ sampleRate: 48000 });
  sp.receive({ type: 'note', track: 0, pitch: 60, velocity: 0.5, when: 0.5, dur: 0, id: 'live', src: 'live' });
  pump(sp);
  sp.receive({ type: 'resetSource', src: 'transport', gen: 2 });
  pump(sp);
  assert.equal(sp.events.length, 1, '实时键盘事件不应被运输取消');
  assert.equal(sp.events[0].src, 'live');
});

// ---------------------------------------------------------------- 6. 节拍器
function metronomeRun({ timeSig, fromBeat, seconds }) {
  const project = makeProject({ timeSig, tempo: 120, loop: { enabled: false, start: 0, end: 4 } });
  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  setMetronome(s, true);
  return s.play(fromBeat).then(() => {
    simulate(h, s, 0.06, seconds);
    return { clicks: clicksOf(h.log), project };
  });
}

await record('节拍器：4/4 连续 4 小节 16 次点击，每小节重音', async () => {
  assert.ok(Scheduler, 'Scheduler 未加载');
  // 截止 7.9s，加 0.14s 前瞻仍不会排入第 17 次点击（8.06s）
  const { clicks } = await metronomeRun({ timeSig: [4, 4], fromBeat: 0, seconds: 7.9 });
  assert.equal(clicks.length, 16, `4/4 四小节应有 16 次点击，实际 ${clicks.length}`);
  clicks.forEach((c, k) => {
    assert.ok(near(c.when, 0.06 + k * 0.5, 0.01), `第 ${k + 1} 次点击时间错误：${c.when}`);
    assert.equal(c.accent, k % 4 === 0, `第 ${k + 1} 次重音标记错误`);
  });
});

await record('节拍器：3/4 连续 4 小节 12 次点击', async () => {
  const { clicks } = await metronomeRun({ timeSig: [3, 4], fromBeat: 0, seconds: 5.8 });
  assert.equal(clicks.length, 12, `3/4 四小节应有 12 次点击，实际 ${clicks.length}`);
  clicks.forEach((c, k) => assert.equal(c.accent, k % 3 === 0, `第 ${k + 1} 次重音标记错误`));
});

await record('节拍器：6/8 复合拍按附点四分点击，重音落在小节头', async () => {
  const { clicks } = await metronomeRun({ timeSig: [6, 8], fromBeat: 0, seconds: 5.8 });
  // 6/8 每小节 3 拍（四分换算），点击粒度 1.5 拍 → 每小节 2 次
  assert.equal(clicks.length, 8, `6/8 四小节应有 8 次点击，实际 ${clicks.length}`);
  clicks.forEach((c, k) => {
    assert.ok(near(c.when, 0.06 + k * 0.75, 0.01), `6/8 第 ${k + 1} 次点击时间错误：${c.when}`);
    assert.equal(c.accent, k % 2 === 0, `6/8 第 ${k + 1} 次重音标记错误`);
  });
});

await record('节拍器：从中途小数拍开始不漏拍', async () => {
  const { clicks } = await metronomeRun({ timeSig: [4, 4], fromBeat: 1.3, seconds: 2.0 });
  assert.ok(clicks.length >= 4, `1.3 拍起播应继续产生点击，实际 ${clicks.length}`);
  assert.ok(near(clicks[0].when, 0.06 + (2 - 1.3) * 0.5, 0.02), `首个点击应在第 2 拍（0.41s），实际 ${clicks[0].when}`);
});

// ---------------------------------------------------------------- 7. 变速
await record('变速：120→60→180 BPM 位置连续，不跳拍', async () => {
  assert.ok(Scheduler, 'Scheduler 未加载');
  assert.equal(typeof Scheduler.prototype.setTempo, 'function', 'Scheduler 缺少 setTempo：UI 仍在新速度下换算旧位置');
  const project = makeProject({ clips: [{ start: 0, length: 4, notes: [{ pitch: 60, start: 0, length: 4 }] }] });
  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(0);
  simulate(h, s, 0.06, 1.06);
  const before = s.currentBeat();
  assert.ok(near(before, 2.0, 0.02), `1.06s 应位于第 2 拍，实际 ${before.toFixed(3)}`);
  s.setTempo(60);
  assert.ok(near(s.currentBeat(), before, 0.02), `变速瞬间位置应保持 ${before.toFixed(3)}，实际 ${s.currentBeat().toFixed(3)}`);
  simulate(h, s, 1.06, 2.06);
  assert.ok(near(s.currentBeat(), before + 1, 0.05), `60 BPM 播放 1 秒应前进 1 拍，实际 ${s.currentBeat().toFixed(3)}`);
  s.setTempo(180);
  const after = s.currentBeat();
  assert.ok(after >= before + 0.95, `180 BPM 锚点后不应倒退，实际 ${after.toFixed(3)}`);
  assert.equal(notesOf(h.log).length, 1, '变速后不应重新触发正在持续的旧音');
});

// ---------------------------------------------------------------- 8. 离线 solo / 分轨
await record('离线导出：完整混音遵循 solo，分轨忽略其它轨独奏', async () => {
  assert.ok(session, 'session.ts 未实现：离线导出仍强制 solo:false');
  const project = makeProject({
    tracks: 2,
    clips: [
      { trackId: 't0', start: 0, length: 4, notes: [{ pitch: 60, start: 0, length: 1 }] },
      { trackId: 't1', start: 0, length: 4, notes: [{ pitch: 64, start: 0, length: 1 }] },
    ],
  });
  project.tracks[1].solo = true;
  const mix = session.buildSessionPlan(project, { endBeat: 4 });
  const byIndex = (plan, i) => plan.trackMessages.find((m) => m.index === i).message;
  assert.equal(byIndex(mix, 1).solo, true, '混音计划必须保留轨道独奏');
  assert.equal(byIndex(mix, 0).solo, false, '未独奏轨道应 solo=false');
  assert.equal(byIndex(mix, 0).mute, false, '静音状态不应被 solo 覆盖');

  const stem = session.buildSessionPlan(project, { endBeat: 4, onlyTrack: 't0' });
  assert.equal(byIndex(stem, 0).mute, false, '分轨目标轨不应被静音');
  assert.equal(byIndex(stem, 0).solo, false, '分轨应清除独奏标记');
  assert.equal(byIndex(stem, 1).mute, true, '分轨中其它轨道应静音');
  const stemPitches = stem.notes.map((n) => n.pitch);
  assert.deepEqual(stemPitches, [60], '分轨音符只应包含目标轨');
});

// ---------------------------------------------------------------- 9. 自动化一致
function findPost(log, pred) {
  return log.filter((e) => e.type === 'post' && e.msg && pred(e.msg));
}

await record('自动化：实时与离线在中点得到同一控制值', async () => {
  assert.ok(session, 'session.ts 未实现：实时/离线自动化无法统一');
  const project = makeProject({
    clips: [{ start: 0, length: 4, notes: [{ pitch: 60, start: 0, length: 1 }] }],
  });
  project.tracks[0].automation = [{ paramId: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.9 }] }];

  const plan = session.buildSessionPlan(project, { endBeat: 4 });
  const ctrl = plan.controls.filter((c) => c.trackIndex === 0);
  const mid = ctrl.find((c) => near(c.beat, 2, 1e-6));
  assert.ok(mid, `离线计划应包含第 2 拍的控制事件，实际 ${ctrl.length} 个事件`);
  assert.ok(near(mid.message.volume, 0.55, 0.01), `离线中点音量应约 0.55，实际 ${mid.message.volume}`);

  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(0);
  simulate(h, s, 0.06, 2.2);
  const live = findPost(h.log, (m) => m.type === 'track' && m.track === 0 && typeof m.when === 'number' && near(m.when, 0.06 + 1.0, 0.02));
  assert.ok(live.length, '实时播放应在第 2 拍排入控制事件');
  assert.ok(near(live[live.length - 1].msg.volume, 0.55, 0.01), `实时中点音量应约 0.55，实际 ${live[live.length - 1].msg.volume}`);
});

await record('自动化：删除 lane 后恢复静态参数', async () => {
  assert.ok(session, 'session.ts 未实现');
  const project = makeProject({
    clips: [{ start: 0, length: 4, notes: [{ pitch: 60, start: 0, length: 1 }] }],
  });
  project.tracks[0].automation = [{ paramId: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.9 }] }];
  project.tracks[0].volume = 0.85;

  const h = harness(project);
  const s = new Scheduler(h.engine, () => project);
  await s.play(0);
  simulate(h, s, 0.06, 1.0);

  project.tracks[0].automation = [];
  s.tick();
  const immediate = findPost(h.log, (m) => m.type === 'track' && m.track === 0 && m.when === undefined);
  assert.ok(immediate.length, '删除 lane 后应立即下发静态控制值');
  assert.ok(near(immediate[immediate.length - 1].msg.volume, 0.85, 1e-6), `应恢复静态音量 0.85，实际 ${immediate[immediate.length - 1].msg.volume}`);

  const plan = session.buildSessionPlan(project, { endBeat: 4 });
  assert.equal(plan.controls.length, 0, '无自动化 lane 时不应再生成控制事件');
  assert.ok(near(plan.trackMessages[0].message.volume, 0.85, 1e-6), '离线计划应使用静态音量');
});

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log('\n---------------------------------------------');
console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) {
  process.exitCode = 1;
  console.log('失败项：');
  for (const f of failed) console.log(`- ${f.name}: ${f.detail}`);
}
