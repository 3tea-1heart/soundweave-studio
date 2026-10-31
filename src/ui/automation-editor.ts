import type { AutomationLane, AutomationPoint, Track } from '../core/types';
import {
  automationRange, automationStaticValue, moveLanePoint, removeLanePointNear,
  removeLanePointsInRange, sortLanePoints, upsertLanePoint,
} from '../core/automation';
import type { AppUi } from './context';

const HEIGHT = 66;
const PAD_Y = 7;
const POINT_R = 3.5;

function projectSpan(ui: AppUi): number {
  const p = ui.getProject();
  let end = Math.max(p.loop.end, 8);
  for (const c of p.clips) end = Math.max(end, c.start + c.length);
  return Math.ceil(end / 4) * 4;
}

/**
 * 检查器内的自动化曲线编辑器：单击/拖动绘制，拖动控制点修改，右键删除。
 * 所有坐标运算都基于拍与参数值，不写入像素。
 */
export function renderAutomationEditor(parent: HTMLElement, ui: AppUi, track: Track, lane: AutomationLane): void {
  const wrap = document.createElement('div');
  wrap.className = 'auto-editor';
  const canvas = document.createElement('canvas');
  canvas.className = 'auto-canvas';
  wrap.appendChild(canvas);
  const readout = document.createElement('div');
  readout.className = 'auto-readout';
  wrap.appendChild(readout);
  parent.appendChild(wrap);

  const range = automationRange(track, lane.paramId);
  const span = projectSpan(ui);
  let width = 0;
  let dragPoint: AutomationPoint | null = null;
  let drawing = false;
  let lastBeat = -1;

  const xToBeat = (x: number): number => Math.max(0, Math.min(span, (x / Math.max(1, width)) * span));
  const beatToX = (b: number): number => (b / span) * width;
  const valueToY = (v: number): number => {
    const t = (v - range.min) / Math.max(1e-6, range.max - range.min);
    return HEIGHT - PAD_Y - t * (HEIGHT - PAD_Y * 2);
  };
  const yToValue = (y: number): number => {
    const t = 1 - (y - PAD_Y) / Math.max(1, HEIGHT - PAD_Y * 2);
    return Math.max(range.min, Math.min(range.max, range.min + t * (range.max - range.min)));
  };

  function resize(): void {
    const w = Math.max(80, wrap.clientWidth || 240);
    if (w === width) return;
    width = w;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(HEIGHT * dpr);
    canvas.style.width = '100%';
    canvas.style.height = `${HEIGHT}px`;
    draw();
  }

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const g = canvas.getContext('2d');
    if (!g || !width) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);
    g.fillStyle = '#0b0e11';
    g.fillRect(0, 0, width, HEIGHT);

    const barBeats = span <= 16 ? 2 : 4;
    g.fillStyle = 'rgba(255,255,255,0.055)';
    for (let b = 0; b <= span; b += barBeats) {
      const x = beatToX(b);
      g.fillRect(Math.floor(x), 0, 1, HEIGHT);
    }
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(0, Math.floor(HEIGHT / 2), width, 1);

    const baseValue = automationStaticValue(track, lane.paramId);
    const pts = lane.points;
    // 数值曲线（与播放时的 laneValue 一致：首尾各延伸为平线）
    g.strokeStyle = '#f3a63c';
    g.lineWidth = 1.5;
    g.beginPath();
    if (!pts.length) {
      const y = valueToY(baseValue);
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.strokeStyle = 'rgba(243,166,60,0.45)';
    } else {
      g.moveTo(0, valueToY(pts[0].value));
      g.lineTo(beatToX(pts[0].beat), valueToY(pts[0].value));
      for (let i = 1; i < pts.length; i++) {
        g.lineTo(beatToX(pts[i].beat), valueToY(pts[i].value));
      }
      g.lineTo(width, valueToY(pts[pts.length - 1].value));
    }
    g.stroke();
    g.lineWidth = 1;

    for (const p of pts) {
      const x = beatToX(p.beat);
      const y = valueToY(p.value);
      g.beginPath();
      g.arc(x, y, p === dragPoint ? POINT_R + 1.5 : POINT_R, 0, Math.PI * 2);
      g.fillStyle = p === dragPoint ? '#ffd58a' : '#f3a63c';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.stroke();
    }
  }

  function updateReadout(cursor?: AutomationPoint): void {
    const p = cursor || lane.points[lane.points.length - 1];
    const valueText = p ? Number(p.value.toFixed(3)) : Number(baseValueText());
    readout.innerHTML =
      `<span>${Number(range.min.toFixed(2))} – ${Number(range.max.toFixed(2))}</span>`
      + `<span>${lane.points.length} 点${p ? ` · ${valueText}` : ''}</span>`;
  }
  function baseValueText(): number {
    return automationStaticValue(track, lane.paramId);
  }

  function hitPoint(x: number, y: number): AutomationPoint | null {
    for (let i = lane.points.length - 1; i >= 0; i--) {
      const p = lane.points[i];
      const dx = beatToX(p.beat) - x;
      const dy = valueToY(p.value) - y;
      if (dx * dx + dy * dy <= (POINT_R + 4) * (POINT_R + 4)) return p;
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const beat = xToBeat(e.offsetX);
    const point = hitPoint(e.offsetX, e.offsetY);
    if (point) {
      dragPoint = point;
    } else {
      drawing = true;
      lastBeat = beat;
      dragPoint = upsertLanePoint(lane, Math.round(beat * 4) / 4, yToValue(e.offsetY), 0.06, range);
      ui.softUpdate();
    }
    draw();
    updateReadout(dragPoint || undefined);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragPoint && !drawing) return;
    const beat = xToBeat(e.offsetX);
    const value = yToValue(e.offsetY);
    if (drawing) {
      if (Math.abs(beat - lastBeat) < 0.12 && lane.points.length) {
        const last = lane.points[lane.points.length - 1];
        if (Math.abs(last.beat - beat) < 0.12) {
          last.value = value;
          ui.softUpdate();
          draw();
          updateReadout(last);
          return;
        }
      }
      // 绘制时覆盖区间内的旧点，避免同一条曲线上留下锯齿状重复点
      removeLanePointsInRange(lane, lastBeat, beat);
      sortLanePoints(lane);
      dragPoint = upsertLanePoint(lane, Math.round(beat * 4) / 4, value, 0.06, range);
      lastBeat = beat;
    } else if (dragPoint) {
      moveLanePoint(lane, dragPoint, Math.round(beat * 4) / 4, value, range);
    }
    ui.softUpdate();
    draw();
    updateReadout(dragPoint || undefined);
  });

  const finish = (): void => {
    if (!dragPoint && !drawing) return;
    dragPoint = null;
    drawing = false;
    sortLanePoints(lane);
    draw();
    updateReadout();
    ui.commit('编辑自动化曲线');
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const beat = xToBeat(e.offsetX);
    const value = yToValue(e.offsetY);
    const beatTol = (POINT_R + 4) / Math.max(1, width) * span;
    const valueTol = (POINT_R + 4) / Math.max(1, HEIGHT - PAD_Y * 2) * (range.max - range.min);
    if (removeLanePointNear(lane, beat, value, beatTol, valueTol)) {
      ui.softUpdate();
      draw();
      updateReadout();
      ui.commit('删除自动化点');
    }
  });

  const ro = new ResizeObserver(() => resize());
  ro.observe(wrap);
  resize();
  updateReadout();
}
