import type { AppUi } from './context';
import { createTrack } from '../core/project';
import { defaultPresetForType } from '../core/presets';
import { mergeParams } from '../core/instrument-defaults';

const TYPE_LABEL: Record<string, string> = { ep: '电钢琴', piano: '钢琴', guitar: '吉他', synth: '合成器', bass: '贝斯', drum: '鼓机' };

export class Mixer {
  private el: HTMLElement;
  private ui: AppUi;
  private meters = new Map<string, HTMLElement>();
  private builtFor = '';

  constructor(el: HTMLElement, ui: AppUi) {
    this.el = el;
    this.ui = ui;
  }

  render(): void {
    const project = this.ui.getProject();
    const key = project.tracks
      .map((t) => `${t.id}:${t.name}:${t.mute}:${t.solo}:${t.kind}:${t.instrument.presetId}`)
      .join('|');
    if (key === this.builtFor && this.el.childElementCount) return;
    this.builtFor = key;
    this.el.innerHTML = '';
    this.meters.clear();
    const wrap = document.createElement('div');
    wrap.className = 'mixer-strips';
    project.tracks.slice(0, 15).forEach((track, i) => {
      const strip = document.createElement('div');
      strip.className = 'strip';
      if (track.id === this.ui.getSelectedTrackId()) strip.classList.add('selected');
      strip.style.setProperty('--track-color', track.color);

      const top = document.createElement('div');
      top.className = 'strip-top';
      top.innerHTML = `<span class="strip-index">${i + 1}</span><span class="strip-name">${track.name}</span>`;
      top.onclick = () => this.ui.selectTrack(track.id);

      const type = document.createElement('div');
      type.className = 'strip-type';
      type.textContent = track.kind === 'audio' ? '音频' : TYPE_LABEL[track.instrument.type] || track.instrument.type;

      const ms = document.createElement('div');
      ms.className = 'strip-ms';
      const mute = document.createElement('button');
      mute.textContent = 'M';
      mute.title = '静音';
      mute.className = track.mute ? 'mini on danger' : 'mini';
      mute.onclick = () => {
        track.mute = !track.mute;
        this.ui.softUpdate();
        this.ui.commit('静音');
        this.render();
      };
      const solo = document.createElement('button');
      solo.textContent = 'S';
      solo.title = '独奏';
      solo.className = track.solo ? 'mini on warn' : 'mini';
      solo.onclick = () => {
        track.solo = !track.solo;
        this.ui.softUpdate();
        this.ui.commit('独奏');
        this.render();
      };
      ms.append(mute, solo);

      const faderArea = document.createElement('div');
      faderArea.className = 'strip-fader';
      const fader = document.createElement('div');
      fader.className = 'fader';
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '1';
      vol.step = '0.01';
      vol.value = String(track.volume);
      vol.title = `音量 ${Math.round(track.volume * 100)}%`;
      vol.oninput = () => {
        track.volume = Number(vol.value);
        vol.title = `音量 ${Math.round(track.volume * 100)}%`;
        this.ui.softUpdate();
        this.ui.recordAutomation('volume', track.volume);
      };
      vol.onchange = () => this.ui.commit('调节音量');
      fader.appendChild(vol);

      const meterWrap = document.createElement('div');
      meterWrap.className = 'meter';
      meterWrap.title = '电平';
      const meter = document.createElement('div');
      meter.className = 'meter-fill';
      meterWrap.appendChild(meter);
      this.meters.set(track.id, meter);
      faderArea.append(fader, meterWrap);

      const sends = document.createElement('div');
      sends.className = 'strip-sends';
      const mkSend = (label: string, value: number, min: number, max: number, apply: (v: number) => void, title: string) => {
        const row = document.createElement('div');
        row.className = 'send-row';
        const tag = document.createElement('span');
        tag.textContent = label;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = '0.01';
        input.value = String(value);
        input.title = title;
        input.oninput = () => {
          apply(Number(input.value));
          this.ui.softUpdate();
        };
        input.onchange = () => this.ui.commit(title);
        row.append(tag, input);
        sends.appendChild(row);
        return input;
      };
      mkSend('PAN', track.pan, -1, 1, (v) => {
        track.pan = v;
        this.ui.recordAutomation('pan', v);
      }, '调节声像');
      mkSend('REV', track.sendReverb, 0, 1, (v) => {
        track.sendReverb = v;
        this.ui.recordAutomation('sendReverb', v);
      }, '调节混响');

      strip.append(top, type, ms, faderArea, sends);
      wrap.appendChild(strip);
    });

    if (project.tracks.length < 15) {
      const add = document.createElement('button');
      add.className = 'strip-add';
      add.textContent = '+ 轨道';
      add.onclick = () => {
        const preset = defaultPresetForType('synth');
        const track = createTrack(project.tracks.length, {
          presetId: preset.id,
          type: preset.type,
          params: mergeParams(preset.type, preset.params),
        }, `合成器 ${project.tracks.length + 1}`);
        project.tracks.push(track);
        this.ui.selectTrack(track.id);
        this.ui.commit('添加轨道');
        this.builtFor = '';
        this.render();
      };
      wrap.appendChild(add);
    }
    this.el.appendChild(wrap);
  }

  setLevels(tracks: number[]): void {
    const project = this.ui.getProject();
    project.tracks.forEach((t, i) => {
      const m = this.meters.get(t.id);
      if (!m) return;
      const v = Math.max(tracks[i] || 0, 0);
      m.style.height = `${Math.min(100, v * 120)}%`;
      m.classList.toggle('hot', v > 0.82);
    });
  }
}
