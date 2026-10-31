import type { AppUi, TrackFxField } from './context';
import { PARAM_DEFS, DRUM_NAMES } from '../core/instrument-defaults';
import { presetById } from '../core/presets';
import { automationLabel } from '../core/automation';
import { renderAutomationEditor } from './automation-editor';
import { targetLabel, targetRange, type MidiLearnTarget } from '../core/midi-learn';
import { assetById } from '../core/audio-asset';
import type { Preset, PresetMacro, Track, AutomationLane, Clip } from '../core/types';

const TYPE_LABEL: Record<string, string> = {
  ep: '电钢琴', piano: '钢琴', guitar: '吉他', synth: '合成器', bass: '贝斯', drum: '鼓机',
};

const FX_DEFS: Array<{ key: TrackFxField; label: string; min: number; max: number; step: number; unit?: string }> = [
  { key: 'sendReverb', label: '混响发送', min: 0, max: 1, step: 0.01 },
  { key: 'sendDelay', label: '延迟发送', min: 0, max: 1, step: 0.01 },
  { key: 'tone', label: '音色低通', min: 0.1, max: 1, step: 0.01 },
  { key: 'drive', label: '过载', min: 0, max: 1, step: 0.01 },
  { key: 'chorus', label: '合唱', min: 0, max: 1, step: 0.01 },
];

export class Inspector {
  private el: HTMLElement;
  private ui: AppUi;
  private macroCache = new Map<string, number>();

  constructor(el: HTMLElement, ui: AppUi) {
    this.el = el;
    this.ui = ui;
  }

  render(): void {
    this.el.innerHTML = '';
    const track = this.ui.getSelectedTrack();
    if (!track) {
      const empty = document.createElement('div');
      empty.className = 'inspector-empty';
      empty.textContent = '选择一条轨道查看音色与参数';
      this.el.appendChild(empty);
      return;
    }
    if (track.kind === 'audio') {
      this.renderTrackHeader(track);
      this.renderAudio(track);
      this.renderAutomation(track);
      this.renderAudioClip();
      this.renderMaster();
      return;
    }
    const preset = presetById(track.instrument.presetId);
    this.renderTrackHeader(track, preset);
    this.renderMacros(track, preset);
    this.renderParams(track);
    this.renderFx(track);
    this.renderMidi(track);
    this.renderAutomation(track);
    this.renderClip();
    this.renderMaster();
  }

  private section(title: string): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'insp-section';
    const head = document.createElement('div');
    head.className = 'insp-head';
    head.textContent = title;
    sec.appendChild(head);
    this.el.appendChild(sec);
    return sec;
  }

  private renderTrackHeader(track: Track, preset?: Preset): void {
    const isAudio = track.kind === 'audio';
    const sec = this.section('轨道');
    const row = document.createElement('div');
    row.className = 'track-title';
    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.background = track.color;
    const name = document.createElement('input');
    name.className = 'track-name-input';
    name.value = track.name;
    name.spellcheck = false;
    name.onchange = () => {
      const v = name.value.trim();
      if (v) this.ui.renameTrack(track.id, v);
    };
    row.append(dot, name);
    sec.appendChild(row);

    const meta = document.createElement('div');
    meta.className = 'track-meta';
    if (isAudio) {
      const count = this.ui.getProject().clips.filter((c) => c.trackId === track.id && c.audio).length;
      meta.innerHTML = `<span>音频轨</span><span class="meta-preset">${count} 个片段</span>`;
    } else {
      meta.innerHTML = `<span>${TYPE_LABEL[track.instrument.type] || track.instrument.type}</span><span class="meta-preset">${preset ? preset.name : track.instrument.presetId}</span>`;
    }
    sec.appendChild(meta);

    if (!isAudio && preset) {
      const desc = document.createElement('div');
      desc.className = 'preset-desc';
      desc.textContent = preset.description;
      sec.appendChild(desc);
    }

    const actions = document.createElement('div');
    actions.className = 'insp-actions';
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = '删除轨道';
    del.onclick = () => {
      if (this.ui.getProject().tracks.length <= 1) {
        this.ui.notify('至少保留一条轨道', 'warn');
        return;
      }
      if (window.confirm(`删除轨道「${track.name}」及其全部片段？`)) this.ui.deleteTrack(track.id);
    };
    const clearAuto = document.createElement('button');
    clearAuto.className = 'mini';
    clearAuto.textContent = '清空自动化';
    clearAuto.onclick = () => {
      track.automation = [];
      this.ui.commit('清空自动化');
    };
    const savePreset = document.createElement('button');
    savePreset.className = 'mini';
    savePreset.textContent = '保存音色';
    savePreset.title = '把当前参数与效果存为自定义音色';
    savePreset.onclick = () => {
      const suggested = `${preset ? preset.name : track.name} 副本`;
      const name = window.prompt('自定义音色名称', suggested);
      if (name === null) return;
      if (this.ui.saveTrackAsPreset(name.trim() || suggested)) this.render();
    };
    if (isAudio) actions.append(clearAuto, del);
    else actions.append(savePreset, clearAuto, del);
    sec.appendChild(actions);
  }

  /** 音频轨：素材状态（缺失 PCM 时给出重新导入提示） */
  private renderAudio(track: Track): void {
    const sec = this.section('音频素材');
    const project = this.ui.getProject();
    const used = new Set<string>();
    for (const clip of project.clips) {
      if (clip.trackId === track.id && clip.audio) used.add(clip.audio.assetId);
    }
    const hint = document.createElement('div');
    hint.className = 'auto-hint';
    hint.textContent = '文件栏「导入 WAV」会把素材添加为片段；支持 8/16/24/32 位 PCM 与浮点 WAV，单个最长 300 秒。';
    sec.appendChild(hint);
    if (!used.size) {
      const none = document.createElement('div');
      none.className = 'auto-empty';
      none.textContent = '尚无音频片段。';
      sec.appendChild(none);
      return;
    }
    for (const id of used) {
      const asset = assetById(project.audioAssets, id);
      const row = document.createElement('div');
      row.className = 'audio-asset-row';
      const name = document.createElement('span');
      name.className = 'audio-asset-name';
      name.textContent = asset ? asset.name : `${id}（未载入）`;
      const meta = document.createElement('span');
      meta.className = 'audio-asset-meta';
      meta.textContent = asset
        ? `${asset.duration.toFixed(2)} 秒 · ${asset.sampleRate} Hz · ${asset.channels === 2 ? '立体声' : '单声道'}`
        : '素材缺失';
      row.append(name, meta);
      sec.appendChild(row);
      if (!asset || !asset.data) {
        const warn = document.createElement('div');
        warn.className = 'audio-asset-warn';
        warn.textContent = '缺少 PCM 数据：重新导入同一 WAV 后片段即可发声。';
        sec.appendChild(warn);
      }
    }
  }

  /** 音频片段：增益、素材起点、复制/删除（音频没有移调与量化） */
  private renderAudioClip(): void {
    const clip = this.ui.getSelectedClip();
    if (!clip?.audio) return;
    const project = this.ui.getProject();
    const asset = assetById(project.audioAssets, clip.audio.assetId);
    const sec = this.section('音频片段');
    const info = document.createElement('div');
    info.className = 'clip-info';
    info.innerHTML = `<span>${clip.name}</span><span>起点 ${clip.start.toFixed(2)} 拍 · 长度 ${clip.length.toFixed(2)} 拍</span>`;
    sec.appendChild(info);

    if (!asset || !asset.data) {
      const warn = document.createElement('div');
      warn.className = 'audio-asset-warn';
      warn.textContent = '该片段的素材缺少 PCM，当前不会发声。';
      sec.appendChild(warn);
    }

    this.sliderRow(sec, '片段增益', 0, 2, 0.01, clip.audio.gain, (v) => {
      if (!clip.audio) return;
      clip.audio.gain = v;
      this.ui.softUpdate();
    }, () => this.ui.commit('片段增益'));

    if (asset) {
      const maxOffset = Math.max(0, Number((asset.duration - 0.05).toFixed(2)));
      this.sliderRow(sec, '素材起点', 0, maxOffset, 0.01, clip.audio.offsetSec, (v) => {
        if (!clip.audio) return;
        clip.audio.offsetSec = Math.min(v, maxOffset);
        this.ui.softUpdate();
      }, () => this.ui.commit('素材起点'), '秒');
    }

    const actions = document.createElement('div');
    actions.className = 'insp-actions';
    const dup = document.createElement('button');
    dup.className = 'mini';
    dup.textContent = '复制片段';
    dup.onclick = () => {
      const copy = JSON.parse(JSON.stringify(clip)) as Clip;
      copy.id = `c_${Math.random().toString(36).slice(2, 8)}`;
      copy.start = clip.start + clip.length;
      project.clips.push(copy);
      this.ui.selectClip(copy.id);
      this.ui.commit('复制片段');
    };
    const rm = document.createElement('button');
    rm.className = 'mini danger';
    rm.textContent = '删除片段';
    rm.onclick = () => {
      project.clips = project.clips.filter((c) => c.id !== clip.id);
      this.ui.selectClip(null);
      this.ui.commit('删除片段');
    };
    actions.append(dup, rm);
    sec.appendChild(actions);
  }

  private renderMacros(track: Track, preset: Preset | undefined): void {
    if (!preset || !preset.macros.length) return;
    const sec = this.section('音色宏');
    for (const macro of preset.macros) {
      const key = `${track.id}:${preset.id}:${macro.id}`;
      const init = this.macroCache.get(key) ?? this.inferMacro(track, macro);
      const row = this.sliderRow(sec, macro.name, 0, 1, 0.01, init, (v) => {
        this.macroCache.set(key, v);
        this.applyMacro(track, macro, v);
      }, () => this.ui.commit('音色宏'));
      row.input.title = macro.targets
        .map((t) => (t.param ? `${t.param} ${t.min}–${t.max}` : `${t.fx} ${t.min}–${t.max}`))
        .join('，');
    }
  }

  private inferMacro(track: Track, macro: PresetMacro): number {
    let sum = 0;
    let n = 0;
    for (const t of macro.targets) {
      const cur = t.param ? track.instrument.params[t.param] : (track as unknown as Record<string, number>)[t.fx || ''];
      if (typeof cur === 'number' && t.max > t.min) {
        sum += Math.max(0, Math.min(1, (cur - t.min) / (t.max - t.min)));
        n++;
      }
    }
    return n ? sum / n : 0.5;
  }

  private applyMacro(track: Track, macro: PresetMacro, v: number): void {
    const patch: Record<string, number> = {};
    for (const t of macro.targets) {
      const value = t.min + (t.max - t.min) * v;
      if (t.param) {
        patch[t.param] = value;
        this.ui.recordAutomation(`param:${t.param}`, value);
      } else if (t.fx) {
        this.ui.setTrackFx(t.fx, value);
        this.ui.recordAutomation(`fx:${t.fx}`, value);
      }
    }
    this.ui.updateParams(patch);
  }

  private renderParams(track: Track): void {
    const defs = PARAM_DEFS[track.instrument.type];
    if (!defs || !defs.length) return;
    const sec = this.section('高级参数');
    for (const def of defs) {
      const value = track.instrument.params[def.key] ?? def.min;
      const row = this.sliderRow(sec, def.label, def.min, def.max, def.step, value, (v) => {
        this.ui.updateParams({ [def.key]: v });
        this.ui.recordAutomation(`param:${def.key}`, v);
      }, () => this.ui.commit('调节参数'), def.unit, { kind: 'param', key: def.key });
      row.input.title = `${def.key} · ${def.min}–${def.max}${def.unit ? ` ${def.unit}` : ''}`;
    }
    if (track.instrument.type === 'drum') {
      const map = document.createElement('div');
      map.className = 'drum-map';
      map.textContent = `打击垫映射：${DRUM_NAMES[36]} / ${DRUM_NAMES[38]} / ${DRUM_NAMES[42]} / ${DRUM_NAMES[44]} …`;
      sec.appendChild(map);
    }
  }

  private renderFx(track: Track): void {
    const sec = this.section('轨道效果');
    for (const def of FX_DEFS) {
      const value = track[def.key] as number;
      this.sliderRow(sec, def.label, def.min, def.max, def.step, value, (v) => {
        this.ui.setTrackFx(def.key, v);
        this.ui.recordAutomation(`fx:${def.key}`, v);
      }, () => this.ui.commit('调节效果'), undefined, { kind: 'fx', key: def.key });
    }
  }

  private renderMidi(track: Track): void {
    const sec = this.section('MIDI 映射');
    const hint = document.createElement('div');
    hint.className = 'auto-hint';
    hint.textContent = '点击参数旁的 L，再移动控制器即可绑定 CC；映射跟随当前选中轨道。';
    sec.appendChild(hint);

    const learning = this.ui.getMidiLearnTarget();
    if (learning) {
      const row = document.createElement('div');
      row.className = 'midi-map-row learning';
      const text = document.createElement('span');
      text.className = 'midi-map-label';
      text.textContent = `正在学习：${targetLabel(track, learning)}`;
      const cancel = document.createElement('button');
      cancel.className = 'mini';
      cancel.textContent = '取消';
      cancel.onclick = () => this.ui.cancelMidiLearn();
      row.append(text, cancel);
      sec.appendChild(row);
    }

    const mappings = this.ui.getMidiMappings();
    if (!mappings.length) {
      const none = document.createElement('div');
      none.className = 'auto-empty';
      none.textContent = '尚无 CC 映射。';
      sec.appendChild(none);
      return;
    }
    for (const mapping of mappings) {
      const row = document.createElement('div');
      row.className = 'midi-map-row';
      const cc = document.createElement('span');
      cc.className = 'midi-badge';
      cc.textContent = `CC${mapping.cc}`;
      const label = document.createElement('span');
      label.className = 'midi-map-label';
      const usable = !!targetRange(track, mapping);
      label.textContent = usable ? targetLabel(track, mapping) : `${targetLabel(track, mapping)}（当前音源不可用）`;
      const rm = document.createElement('button');
      rm.className = 'mini danger';
      rm.textContent = '×';
      rm.title = '删除该 MIDI 映射';
      rm.onclick = () => this.ui.removeMidiMapping(mapping.cc);
      row.append(cc, label, rm);
      sec.appendChild(row);
    }
  }

  private renderAutomation(track: Track): void {
    const sec = this.section('自动化');
    const armed = this.ui.isAutomationArmed();
    const toggle = document.createElement('button');
    toggle.className = armed ? 'auto-toggle on' : 'auto-toggle';
    toggle.textContent = armed ? '自动化录制：开' : '自动化录制：关';
    toggle.onclick = () => {
      this.ui.setAutomationArmed(!armed);
      this.render();
    };
    sec.appendChild(toggle);
    const hint = document.createElement('div');
    hint.className = 'auto-hint';
    hint.textContent = '录制时拖动参数滑杆会写入自动化点；下方曲线可单击/拖动绘制，拖动控制点修改，右键删除。';
    sec.appendChild(hint);

    this.renderAutomationAdder(sec, track);

    if (!track.automation.length) {
      const none = document.createElement('div');
      none.className = 'auto-empty';
      none.textContent = '尚无自动化轨；可从上方选择参数新建。';
      sec.appendChild(none);
      return;
    }
    for (const lane of track.automation) {
      const row = document.createElement('div');
      row.className = 'auto-lane';
      row.innerHTML = `<span>${automationLabel(lane.paramId)}</span><span class="auto-count">${lane.points.length} 点</span>`;
      const rm = document.createElement('button');
      rm.className = 'mini danger';
      rm.textContent = '×';
      rm.title = '删除该自动化轨';
      rm.onclick = () => this.ui.removeAutomationLane(lane.paramId);
      row.appendChild(rm);
      sec.appendChild(row);
      renderAutomationEditor(sec, this.ui, track, lane);
    }
  }

  /** 新建自动化轨：列出当前音源可用参数与轨道效果（音频轨没有音源参数与音源处理） */
  private renderAutomationAdder(parent: HTMLElement, track: Track): void {
    const options: Array<{ id: string; label: string }> = [];
    const isAudio = track.kind === 'audio';
    if (!isAudio) {
      for (const def of PARAM_DEFS[track.instrument.type] || []) {
        options.push({ id: `param:${def.key}`, label: def.label });
      }
    }
    const fxKeys = isAudio
      ? ['volume', 'pan', 'sendReverb', 'sendDelay']
      : ['volume', 'pan', 'sendReverb', 'sendDelay', 'tone', 'drive', 'chorus'];
    for (const fx of fxKeys) {
      options.push({ id: `fx:${fx}`, label: automationLabel(fx) });
    }
    const existing = new Set(track.automation.map((l) => l.paramId));
    const available = options.filter((o) => !existing.has(o.id));
    if (!available.length) return;

    const row = document.createElement('div');
    row.className = 'auto-adder';
    const select = document.createElement('select');
    select.className = 'auto-select';
    for (const opt of available) {
      const el = document.createElement('option');
      el.value = opt.id;
      el.textContent = opt.label;
      select.appendChild(el);
    }
    const add = document.createElement('button');
    add.className = 'mini';
    add.textContent = '新建自动化轨';
    add.onclick = () => {
      const paramId = select.value;
      if (!paramId) return;
      const lane: AutomationLane = { paramId, points: [] };
      track.automation.push(lane);
      this.ui.commit(`新建自动化轨：${automationLabel(paramId)}`);
    };
    row.append(select, add);
    parent.appendChild(row);
  }

  private renderClip(): void {
    const clip = this.ui.getSelectedClip();
    if (!clip) return;
    const sec = this.section('片段');
    const info = document.createElement('div');
    info.className = 'clip-info';
    info.innerHTML = `<span>${clip.name}</span><span>起点 ${clip.start.toFixed(2)} 拍 · 长度 ${clip.length.toFixed(2)} 拍 · ${clip.notes.length} 音符</span>`;
    sec.appendChild(info);

    this.sliderRow(sec, '移调', -12, 12, 1, clip.transpose, (v) => {
      clip.transpose = v;
      this.ui.softUpdate();
    }, () => this.ui.commit('片段移调'), '半音');

    const actions = document.createElement('div');
    actions.className = 'insp-actions';
    const quant = document.createElement('button');
    quant.className = 'mini';
    quant.textContent = '量化音符';
    quant.onclick = () => {
      const snap = this.ui.getSnap();
      for (const n of clip.notes) {
        n.start = Math.max(0, Math.round(n.start / snap) * snap);
        n.length = Math.max(snap / 2, Math.round(n.length / snap) * snap);
      }
      this.ui.commit('量化');
    };
    const dup = document.createElement('button');
    dup.className = 'mini';
    dup.textContent = '复制片段';
    dup.onclick = () => {
      const project = this.ui.getProject();
      const copy = JSON.parse(JSON.stringify(clip));
      copy.id = `c_${Math.random().toString(36).slice(2, 8)}`;
      copy.start = clip.start + clip.length;
      copy.notes = copy.notes.map((n: { id: string }) => ({ ...n, id: `n_${Math.random().toString(36).slice(2, 8)}` }));
      project.clips.push(copy);
      this.ui.selectClip(copy.id);
      this.ui.commit('复制片段');
    };
    const rm = document.createElement('button');
    rm.className = 'mini danger';
    rm.textContent = '删除片段';
    rm.onclick = () => {
      const project = this.ui.getProject();
      project.clips = project.clips.filter((c) => c.id !== clip.id);
      this.ui.selectClip(null);
      this.ui.commit('删除片段');
    };
    actions.append(quant, dup, rm);
    sec.appendChild(actions);

    const notes = this.ui.getSelectedNotes();
    if (notes.length) {
      const selSec = this.section('选中音符');
      const avg = notes.reduce((s, n) => s + n.velocity, 0) / notes.length;
      this.sliderRow(selSec, '力度', 0.05, 1, 0.01, Number(avg.toFixed(2)), (v) => {
        this.ui.setNoteVelocity(v);
      }, () => this.ui.commit('修改力度'));
      const hint = document.createElement('div');
      hint.className = 'auto-hint';
      hint.textContent = `${notes.length} 个音符 · Delete 删除，Ctrl+C / Ctrl+V 复制粘贴，方向键微调`;
      selSec.appendChild(hint);
    }
  }

  private renderMaster(): void {
    const sec = this.section('总线');
    const project = this.ui.getProject();
    this.sliderRow(sec, '主音量', 0, 1, 0.01, project.master.volume, (v) => {
      project.master.volume = v;
      this.ui.engine.post({ type: 'master', volume: v });
    }, () => this.ui.commit('主音量'));
  }

  private sliderRow(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
    onCommit: () => void,
    unit?: string,
    learn?: MidiLearnTarget,
  ): { input: HTMLInputElement; valueLabel: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'param-row';
    const top = document.createElement('div');
    top.className = 'param-top';
    const name = document.createElement('span');
    name.textContent = label;
    const valueLabel = document.createElement('span');
    valueLabel.className = 'param-value';
    const fmt = (v: number) => {
      if (unit === 'Hz') return `${Math.round(v)} Hz`;
      if (unit === '半音') return `${v > 0 ? '+' : ''}${Math.round(v)}`;
      if (unit) return `${Number(v.toFixed(2))} ${unit}`;
      return String(Number(v.toFixed(2)));
    };
    valueLabel.textContent = fmt(value);
    const tools = document.createElement('div');
    tools.className = 'param-tools';
    if (learn) {
      const mapping = this.ui.getMidiMappings().find((m) => m.kind === learn.kind && m.key === learn.key);
      if (mapping) {
        const badge = document.createElement('span');
        badge.className = 'midi-badge';
        badge.textContent = `CC${mapping.cc}`;
        badge.title = `已绑定 CC${mapping.cc}`;
        tools.appendChild(badge);
      }
      const active = this.ui.getMidiLearnTarget();
      const isActive = !!active && active.kind === learn.kind && active.key === learn.key;
      const btn = document.createElement('button');
      btn.className = isActive ? 'midi-learn on' : 'midi-learn';
      btn.textContent = 'L';
      btn.title = isActive ? '正在学习，点击取消' : 'MIDI Learn：点击后移动控制器';
      btn.onclick = () => {
        if (isActive) this.ui.cancelMidiLearn();
        else this.ui.beginMidiLearn(learn.kind, learn.key);
      };
      tools.appendChild(btn);
    }
    tools.appendChild(valueLabel);
    top.append(name, tools);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.oninput = () => {
      const v = Number(input.value);
      valueLabel.textContent = fmt(v);
      onInput(v);
    };
    input.onchange = () => onCommit();
    row.append(top, input);
    parent.appendChild(row);
    return { input, valueLabel };
  }
}
