import { StudioProcessor, defaultParams } from '../src/audio/studio-processor.js';

globalThis.sampleRate = 48000;
const SR = 48000;

function render(type, pitch, params, seconds = 1.2) {
  const sp = new StudioProcessor({ sampleRate: SR });
  sp.receive({ type: 'track', track: 0, instrumentType: type, params: Object.assign(defaultParams(type), params), volume: 1, pan: 0 });
  sp.receive({ type: 'note', track: 0, pitch, velocity: 0.8, when: 0, dur: 1.0 });
  const total = Math.floor(seconds * SR);
  const L = new Float32Array(total);
  const block = new Float32Array(128);
  const zero = new Float32Array(128);
  for (let b = 0; b < Math.ceil(total / 128); b++) {
    block.fill(0);
    zero.fill(0);
    sp.processBlock([block, zero]);
    for (let i = 0; i < 128; i++) {
      const idx = b * 128 + i;
      if (idx < total) L[idx] = block[i];
    }
  }
  return L;
}

function spectrumPeaks(L, startSec, winSec) {
  const start = Math.floor(startSec * SR);
  const N = Math.floor(winSec * SR);
  const bins = 1;
}

function peakFreq(L, startSec, winSec) {
  const start = Math.floor(startSec * SR);
  const N = Math.floor(winSec * SR);
  let best = 0;
  let bestF = 0;
  for (let f = 60; f <= 900; f += 1) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < N; i += 1) {
      const s = L[start + i];
      re += s * Math.cos(w * i);
      im += s * Math.sin(w * i);
    }
    const m = re * re + im * im;
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}

function magAt(L, f, startSec, winSec) {
  const start = Math.floor(startSec * SR);
  const N = Math.floor(winSec * SR);
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * f) / SR;
  for (let i = 0; i < N; i += 1) {
    const s = L[start + i];
    re += s * Math.cos(w * i);
    im += s * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / N;
}

function periodOf(L, startSec, winSec, minLag, maxLag) {
  const start = Math.floor(startSec * SR);
  const N = Math.floor(winSec * SR);
  let best = -1e9;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < N - lag; i += 2) sum += L[start + i] * L[start + i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return bestLag;
}

for (const [type, pitch] of [['guitar', 57], ['guitar', 64], ['guitar', 76], ['ep', 60], ['synth', 52]]) {
  const L = render(type, pitch, type === 'guitar' ? { damping: 0.4, bright: 0.55 } : { octave: 0 });
  const expected = 440 * Math.pow(2, (pitch - 69) / 12);
  const early = peakFreq(L, 0.05, 0.1);
  const late = peakFreq(L, 0.4, 0.2);
  const m1 = magAt(L, expected, 0.4, 0.2);
  const m2 = magAt(L, expected * 2, 0.4, 0.2);
  const m3 = magAt(L, expected * 3, 0.4, 0.2);
  let rms = 0;
  for (let i = Math.floor(0.4 * SR); i < Math.floor(0.8 * SR); i++) rms += L[i] * L[i];
  rms = Math.sqrt(rms / (0.4 * SR));
  console.log(
    `${type} midi=${pitch} expect=${expected.toFixed(1)} early=${early} late=${late} h1=${m1.toFixed(4)} h2=${m2.toFixed(4)} h3=${m3.toFixed(4)} rms=${rms.toFixed(4)}`,
  );
}
