import type { AppUi } from './context';
import { allPresets, userPresets, PRESET_CATEGORIES } from '../core/presets';
import { exportUserPresetsJson, importUserPresets } from '../core/user-presets';
import { allBlocks, BLOCK_CATEGORIES } from '../core/blocks';
import { loadUserBlocks, exportUserBlocksJson, importUserBlocks } from '../core/user-blocks';
import { DEMOS } from '../core/demos';
import { downloadBlob, safeFileName } from '../core/wav';
import { PRESETS } from '../ambient';

type Tab = 'presets' | 'blocks' | 'demos' | 'ambient';

const TYPE_LABEL: Record<string, string> = {
  ep: '电钢琴', piano: '钢琴', guitar: '吉他', synth: '合成器', bass: '贝斯', drum: '鼓机',
};

export class Browser {
  private el: HTMLElement;
  private ui: AppUi;
  private tab: Tab = 'presets';
  private search = '';
  private blockCat: string = 'all';
  private body: HTMLElement;
  private searchInput: HTMLInputElement;
  private tabsEl: HTMLElement;
  private presetActive: string | null = null;

  constructor(el: HTMLElement, ui: AppUi) {
    this.el = el;
    this.ui = ui;
    this.el.innerHTML = '';

    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'tabs';
    const tabs: Array<[Tab, string]> = [['presets', '预设'], ['blocks', '编曲块'], ['demos', '示例'], ['ambient', '生成']];
    for (const [id, label] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.textContent = label;
      btn.dataset.tab = id;
      btn.onclick = () => {
        this.tab = id;
        this.search = '';
        this.searchInput.value = '';
        this.render();
      };
      this.tabsEl.appendChild(btn);
    }
    this.el.appendChild(this.tabsEl);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'browser-search';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.placeholder = '搜索名称、标签、风格…';
    this.searchInput.setAttribute('aria-label', '搜索素材库');
    this.searchInput.addEventListener('input', () => {
      this.search = this.searchInput.value.trim().toLowerCase();
      this.renderBody();
    });
    searchWrap.appendChild(this.searchInput);
    this.el.appendChild(searchWrap);

    this.body = document.createElement('div');
    this.body.className = 'browser-body';
    this.el.appendChild(this.body);

    this.render();
  }

  render(): void {
    const tabs = this.tabsEl.querySelectorAll<HTMLElement>('.tab');
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === this.tab));
    const tab = this.tab;
    this.searchInput.placeholder =
      tab === 'presets' ? '搜索音色名称、标签…' : tab === 'blocks' ? '搜索编曲块、风格…' : tab === 'demos' ? '搜索示例工程…' : '搜索生成风格…';
    this.renderBody();
  }

  private matches(text: string): boolean {
    return !this.search || text.toLowerCase().includes(this.search);
  }

  private renderBody(): void {
    this.body.innerHTML = '';
    if (this.tab === 'presets') this.renderPresets();
    else if (this.tab === 'blocks') this.renderBlocks();
    else if (this.tab === 'demos') this.renderDemos();
    else this.renderAmbient();
  }

  private renderPresets(): void {
    const selected = this.ui.getSelectedTrack();
    const hint = document.createElement('div');
    hint.className = 'browser-hint';
    hint.textContent = selected
      ? `双击应用到「${selected.name}」，▶ 试听，⇄ 与当前音色 A/B 对比`
      : '先在时间轴或调音台选中一条轨道';
    this.body.appendChild(hint);

    this.renderPresetTools();

    const activePresetId = selected?.instrument.presetId;
    const presets = allPresets();
    for (const cat of PRESET_CATEGORIES) {
      const items = presets.filter(
        (p) => p.category === cat && this.matches(`${p.name} ${p.category} ${p.tags.join(' ')} ${p.description}`),
      );
      if (!items.length) continue;
      const group = document.createElement('div');
      group.className = 'browser-group';
      const head = document.createElement('div');
      head.className = 'group-head';
      head.innerHTML = `<span>${cat}</span><span class="count">${items.length}</span>`;
      group.appendChild(head);
      for (const preset of items) {
        const row = document.createElement('div');
        row.className = 'preset-row';
        if (preset.id === activePresetId) row.classList.add('current');
        if (preset.id === this.presetActive) row.classList.add('auditioning');
        row.title = preset.description;
        const main = document.createElement('div');
        main.className = 'preset-main';
        main.innerHTML = `<div class="preset-name">${preset.name}<span class="type-badge">${TYPE_LABEL[preset.type] || preset.type}</span></div><div class="preset-tags">${preset.tags.slice(0, 3).join(' · ')}</div>`;
        row.appendChild(main);

        const audition = document.createElement('button');
        audition.className = 'icon-btn';
        audition.textContent = '▶';
        audition.title = '试听';
        audition.setAttribute('aria-label', '试听');
        audition.onclick = (e) => {
          e.stopPropagation();
          this.presetActive = preset.id;
          this.renderBody();
          this.ui.auditionPreset(preset.id);
        };
        const apply = document.createElement('button');
        apply.className = 'icon-btn apply';
        apply.textContent = '✓';
        apply.title = '应用到当前轨道';
        apply.setAttribute('aria-label', '应用到当前轨道');
        apply.onclick = (e) => {
          e.stopPropagation();
          this.ui.applyPreset(preset.id);
        };
        const ab = document.createElement('button');
        ab.className = 'icon-btn';
        ab.textContent = '⇄';
        ab.title = 'A/B 对比：先试听此音色，再试听当前音色';
        ab.setAttribute('aria-label', 'A/B 对比');
        ab.disabled = !activePresetId || activePresetId === preset.id;
        ab.onclick = (e) => {
          e.stopPropagation();
          this.ui.auditionPair(preset.id);
        };
        row.append(audition, ab, apply);
        if (preset.custom) {
          const del = document.createElement('button');
          del.className = 'icon-btn';
          del.textContent = '×';
          del.title = '删除这个自定义音色';
          del.setAttribute('aria-label', '删除这个自定义音色');
          del.onclick = (e) => {
            e.stopPropagation();
            if (window.confirm(`删除自定义音色「${preset.name}」？`)) this.ui.removeUserPreset(preset.id);
          };
          row.appendChild(del);
        }
        row.ondblclick = () => this.ui.applyPreset(preset.id);
        row.onclick = () => {
          this.presetActive = preset.id;
          this.body.querySelectorAll('.preset-row').forEach((r) => r.classList.remove('auditioning'));
          row.classList.add('auditioning');
          this.ui.auditionPreset(preset.id);
        };
        group.appendChild(row);
      }
      this.body.appendChild(group);
    }
    if (!this.body.querySelector('.browser-group')) {
      const empty = document.createElement('div');
      empty.className = 'browser-empty';
      empty.textContent = '没有匹配的预设';
      this.body.appendChild(empty);
    }
  }

  /** 自定义音色库的导出/导入；保存动作在检查器的轨道区 */
  private renderPresetTools(): void {
    const count = userPresets().length;
    const chips = document.createElement('div');
    chips.className = 'chips';
    const label = document.createElement('span');
    label.className = 'chips-label';
    label.textContent = count ? `我的音色 ${count}` : '还没有自定义音色';
    chips.appendChild(label);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'chip';
    exportBtn.textContent = '导出';
    exportBtn.title = '把自定义音色导出为 JSON';
    exportBtn.disabled = count === 0;
    exportBtn.onclick = () => {
      if (!count) return;
      const text = exportUserPresetsJson();
      downloadBlob(new Blob([text], { type: 'application/json' }), 'soundweave-presets.json');
      this.ui.notify(`已导出 ${count} 个自定义音色`);
    };
    chips.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.className = 'chip';
    importBtn.textContent = '导入';
    importBtn.title = '从 JSON 音色库导入（同 ID 会跳过）';
    importBtn.onclick = () => picker.click();
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.json,application/json';
    picker.hidden = true;
    picker.onchange = () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      void file.text().then((text) => {
        try {
          const { added, skipped } = importUserPresets(text);
          this.ui.notify(`已导入 ${added} 个音色${skipped ? `，跳过 ${skipped} 个` : ''}`);
          this.render();
        } catch (err) {
          this.ui.notify(`导入音色失败：${String(err)}`, 'error');
        }
      });
    };
    chips.appendChild(importBtn);
    chips.appendChild(picker);
    this.body.appendChild(chips);
  }

  private renderBlocks(): void {
    const chips = document.createElement('div');
    chips.className = 'chips';
    const all = document.createElement('button');
    all.className = this.blockCat === 'all' ? 'chip active' : 'chip';
    all.textContent = '全部';
    all.onclick = () => { this.blockCat = 'all'; this.renderBody(); };
    chips.appendChild(all);
    for (const c of BLOCK_CATEGORIES) {
      const chip = document.createElement('button');
      chip.className = this.blockCat === c.id ? 'chip active' : 'chip';
      chip.textContent = c.label;
      chip.onclick = () => { this.blockCat = c.id; this.renderBody(); };
      chips.appendChild(chip);
    }
    this.body.appendChild(chips);

    this.renderBlockTools();

    const hint = document.createElement('div');
    hint.className = 'browser-hint';
    hint.textContent = '拖到时间轴任意轨道，或双击插入到播放头位置';
    this.body.appendChild(hint);

    const list = allBlocks().filter(
      (b) =>
        (this.blockCat === 'all' || b.category === this.blockCat) &&
        this.matches(`${b.name} ${b.style} ${b.tags.join(' ')} ${b.key}`),
    );
    for (const block of list) {
      const row = document.createElement('div');
      row.className = 'block-row';
      if (block.custom) row.classList.add('custom');
      row.draggable = true;
      row.title = `${block.name} · ${block.bars} 小节 · ${block.style}`;
      row.innerHTML = `<div class="block-main"><div class="block-name">${block.name}<span class="bars-badge">${block.bars} 小节</span></div><div class="preset-tags">${block.key} · ${block.style} · ${block.tempoRange[0]}–${block.tempoRange[1]} BPM</div></div>`;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('application/x-soundweave-block', block.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      const insert = document.createElement('button');
      insert.className = 'icon-btn apply';
      insert.textContent = '+';
      insert.title = '插入到播放头';
      insert.setAttribute('aria-label', '插入到播放头');
      insert.onclick = (e) => {
        e.stopPropagation();
        const track = this.ui.getSelectedTrack();
        if (!track) {
          this.ui.notify('请先选择一条轨道', 'warn');
          return;
        }
        this.ui.insertBlock(block.id, track.id, this.ui.getPlayhead());
      };
      row.appendChild(insert);
      if (block.custom) {
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.textContent = '×';
        del.title = '删除这个自定义编曲块';
        del.setAttribute('aria-label', '删除这个自定义编曲块');
        del.onclick = (e) => {
          e.stopPropagation();
          if (window.confirm(`删除自定义编曲块「${block.name}」？`)) this.ui.removeUserBlock(block.id);
        };
        row.appendChild(del);
      }
      row.ondblclick = () => {
        const track = this.ui.getSelectedTrack();
        if (!track) {
          this.ui.notify('请先选择一条轨道', 'warn');
          return;
        }
        this.ui.insertBlock(block.id, track.id, this.ui.getPlayhead());
      };
      this.body.appendChild(row);
    }
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'browser-empty';
      empty.textContent = '没有匹配的编曲块';
      this.body.appendChild(empty);
    }
  }

  /** 保存当前片段为编曲块，以及编曲块库的导出/导入 */
  private renderBlockTools(): void {
    const count = loadUserBlocks().length;
    const chips = document.createElement('div');
    chips.className = 'chips';
    const label = document.createElement('span');
    label.className = 'chips-label';
    label.textContent = count ? `我的编曲块 ${count}` : '还没有自定义编曲块';
    chips.appendChild(label);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'chip';
    saveBtn.textContent = '保存片段';
    saveBtn.title = '把当前选中的片段存为编曲块';
    saveBtn.onclick = () => {
      const clip = this.ui.getSelectedClip();
      if (!clip) {
        this.ui.notify('请先在时间轴上选择一个片段', 'warn');
        return;
      }
      const name = window.prompt('编曲块名称', clip.name || '自定义编曲块');
      if (name === null) return;
      this.ui.saveClipAsBlock(name.trim() || clip.name || '自定义编曲块');
    };
    chips.appendChild(saveBtn);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'chip';
    exportBtn.textContent = '导出';
    exportBtn.title = '把自定义编曲块导出为 JSON';
    exportBtn.disabled = count === 0;
    exportBtn.onclick = () => {
      if (!count) return;
      downloadBlob(new Blob([exportUserBlocksJson()], { type: 'application/json' }), 'soundweave-blocks.json');
      this.ui.notify(`已导出 ${count} 个自定义编曲块`);
    };
    chips.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.className = 'chip';
    importBtn.textContent = '导入';
    importBtn.title = '从 JSON 编曲块库导入（同 ID 会跳过）';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.json,application/json';
    picker.hidden = true;
    importBtn.onclick = () => picker.click();
    picker.onchange = () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      void file.text().then((text) => {
        try {
          const { added, skipped } = importUserBlocks(text);
          this.ui.notify(`已导入 ${added} 个编曲块${skipped ? `，跳过 ${skipped} 个` : ''}`);
          this.render();
        } catch (err) {
          this.ui.notify(`导入编曲块失败：${String(err)}`, 'error');
        }
      });
    };
    chips.append(importBtn, picker);
    this.body.appendChild(chips);
  }

  private renderDemos(): void {
    const hint = document.createElement('div');
    hint.className = 'browser-hint';
    hint.textContent = '载入示例会替换当前工程（未保存内容会丢失）';
    this.body.appendChild(hint);
    for (const demo of DEMOS) {
      if (!this.matches(`${demo.name} ${demo.description}`)) continue;
      const card = document.createElement('div');
      card.className = 'demo-card';
      card.innerHTML = `<div class="demo-name">${demo.name}</div><div class="demo-desc">${demo.description}</div>`;
      const btn = document.createElement('button');
      btn.className = 'demo-load';
      btn.textContent = '载入工程';
      btn.onclick = () => this.ui.loadDemo(demo.id);
      card.appendChild(btn);
      this.body.appendChild(card);
    }
  }

  /** 生成式 ambient：从风格预设生成一段完整工程并载入 */
  private renderAmbient(): void {
    const hint = document.createElement('div');
    hint.className = 'browser-hint';
    hint.textContent = '从风格预设生成一段 ambient 工程（会替换当前工程）';
    this.body.appendChild(hint);

    const controls = document.createElement('div');
    controls.className = 'ambient-controls';

    const durLabel = document.createElement('label');
    durLabel.className = 'ambient-field';
    durLabel.textContent = '时长 ';
    const dur = document.createElement('select');
    dur.setAttribute('aria-label', '生成时长');
    for (const [val, label] of [[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟']] as const) {
      const o = document.createElement('option');
      o.value = String(val);
      o.textContent = label;
      if (val === 300) o.selected = true;
      dur.appendChild(o);
    }
    durLabel.appendChild(dur);

    const seedLabel = document.createElement('label');
    seedLabel.className = 'ambient-field';
    seedLabel.textContent = '种子 ';
    const seedInput = document.createElement('input');
    seedInput.type = 'text';
    seedInput.placeholder = '留空随机';
    seedInput.setAttribute('aria-label', '随机种子');
    seedLabel.appendChild(seedInput);

    const tempoLabel = document.createElement('label');
    tempoLabel.className = 'ambient-field';
    tempoLabel.textContent = '速度 ';
    const tempoInput = document.createElement('input');
    tempoInput.type = 'number';
    tempoInput.min = '30';
    tempoInput.max = '240';
    tempoInput.placeholder = '自动';
    tempoInput.setAttribute('aria-label', '速度（拍/分）');
    tempoLabel.appendChild(tempoInput);

    controls.append(durLabel, seedLabel, tempoLabel);
    this.body.appendChild(controls);

    for (const preset of PRESETS) {
      if (!this.matches(`${preset.name} ${preset.description}`)) continue;
      const card = document.createElement('div');
      card.className = 'demo-card';
      card.innerHTML = `<div class="demo-name">${preset.name}</div><div class="demo-desc">${preset.description}</div>`;
      const btn = document.createElement('button');
      btn.className = 'demo-load';
      btn.textContent = '生成工程';
      btn.onclick = () => {
        const durationSec = Number(dur.value) || preset.durationSec;
        const tempoRaw = Number(tempoInput.value);
        const tempo = Number.isFinite(tempoRaw) && tempoRaw >= 30 && tempoRaw <= 240 ? Math.round(tempoRaw) : undefined;
        this.ui.ambientGenerate(preset.id, { seed: seedInput.value, durationSec, tempo });
      };
      card.appendChild(btn);
      this.body.appendChild(card);
    }
  }
}
