/**
 * SoundWeave / 声织 — studio DSP processor.
 * 该文件同时被浏览器 AudioWorklet 与 Node 离线渲染测试加载，因此保持纯 JavaScript。
 * 16 条轨道、音源、插入效果、发送效果与总线均在此完成，实时与导出共用同一份代码。
 */

const TWO_PI = Math.PI * 2;

function mtof(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
/**
 * 只接受有限数值。消息来自 UI、自动化、工程文件与 MIDI，任意一处出现 NaN/undefined
 * 都会被 dsp 滤波器状态放大成永久静音，因此所有外部数值先过这道门。
 */
function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function softsat(x) {
  return x / (1 + Math.abs(x));
}
/** 平滑饱和曲线（Padé 近似 tanh），比 Math.tanh 更适合逐采样使用 */
function tanhFast(x) {
  const v = x < -3 ? -3 : x > 3 ? 3 : x;
  const v2 = v * v;
  return (v * (27 + v2)) / (27 + 9 * v2);
}
class DCBlock {
  constructor() {
    this.x1 = 0;
    this.y1 = 0;
  }
  reset() {
    this.x1 = 0;
    this.y1 = 0;
  }
  run(x) {
    const y = x - this.x1 + 0.9985 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t * t - 2 * t + 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + 2 * t + 1;
  }
  return 0;
}

class RNG {
  constructor(seed) {
    this.s = (seed | 0) || 123456789;
    if (this.s === 0) this.s = 123456789;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return (x >>> 0) / 4294967296;
  }
  bipolar() {
    return this.next() * 2 - 1;
  }
}

class Env {
  constructor(sr) {
    this.sr = sr;
    this.v = 0;
    this.stage = 0; // 0 idle 1 attack 2 decay 3 sustain 4 release
    this.attackSamples = 1;
    this.decayCoef = 0.9;
    this.relCoef = 0.9;
    this.sustain = 1;
  }
  config(attack, decay, sustain, release) {
    this.attackSamples = Math.max(1, (attack || 0.001) * this.sr);
    this.decayCoef = decay <= 0.0001 ? 0 : Math.exp(-1 / (decay * this.sr));
    this.relCoef = release <= 0.0001 ? 0 : Math.exp(-1 / (release * this.sr));
    this.sustain = sustain;
  }
  trigger() {
    this.v = 0;
    this.stage = 1;
  }
  release() {
    if (this.stage !== 0 && this.stage !== 4) this.stage = 4;
  }
  tick() {
    switch (this.stage) {
      case 1:
        this.v += 1 / this.attackSamples;
        if (this.v >= 1) {
          this.v = 1;
          this.stage = 2;
        }
        break;
      case 2:
        this.v = this.sustain + (this.v - this.sustain) * this.decayCoef;
        break;
      case 3:
        this.v = this.sustain;
        break;
      case 4:
        this.v *= this.relCoef;
        if (this.v < 0.0004) {
          this.v = 0;
          this.stage = 0;
        }
        break;
      default:
        this.v = 0;
    }
    return this.v;
  }
}

class SVF {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
  }
  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }
  /** returns lowpass output; band/high stored in this.band / this.high */
  run(x, g, k) {
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.band = v1;
    this.high = x - k * v1 - v2;
    return v2;
  }
}

function svfG(cutoff, sr) {
  return Math.tan(Math.PI * clamp(cutoff, 20, sr * 0.45) / sr);
}

class OnePole {
  constructor() {
    this.y = 0;
  }
  run(x, a) {
    this.y += (x - this.y) * a;
    return this.y;
  }
}

class Comb {
  constructor(sr, ms, feedback, damp) {
    this.size = Math.max(2, Math.floor((ms / 1000) * sr));
    this.buf = new Float32Array(this.size);
    this.idx = 0;
    this.fb = feedback;
    this.damp = damp;
    this.lp = 0;
  }
  run(x) {
    const out = this.buf[this.idx];
    this.lp = out * (1 - this.damp) + this.lp * this.damp;
    this.buf[this.idx] = x + this.lp * this.fb;
    this.idx = (this.idx + 1) % this.size;
    return out;
  }
  reset() {
    this.buf.fill(0);
    this.idx = 0;
    this.lp = 0;
  }
}

class Allpass {
  constructor(sr, ms, g) {
    this.size = Math.max(2, Math.floor((ms / 1000) * sr));
    this.buf = new Float32Array(this.size);
    this.idx = 0;
    this.g = g;
  }
  run(x) {
    const bufout = this.buf[this.idx];
    const out = bufout - x;
    this.buf[this.idx] = x + bufout * this.g;
    this.idx = (this.idx + 1) % this.size;
    return out;
  }
  reset() {
    this.buf.fill(0);
    this.idx = 0;
  }
}

class Reverb {
  constructor(sr) {
    // 8 路并联梳状滤波器 + 3 级全通扩散，接近 Freeverb 的密度；
    // 左右使用略微不同的延时，天然产生立体声宽度。
    const fb = 0.855;
    const damp = 0.28;
    const tL = [23.7, 26.1, 28.4, 30.2, 32.6, 35.1, 37.4, 40.2];
    const tR = [24.4, 26.8, 29.1, 31.1, 33.4, 35.9, 38.3, 41.4];
    this.combsL = tL.map((t) => new Comb(sr, t, fb, damp));
    this.combsR = tR.map((t) => new Comb(sr, t, fb, damp));
    this.apL = [new Allpass(sr, 4.9, 0.5), new Allpass(sr, 4.2, 0.5), new Allpass(sr, 3.4, 0.5)];
    this.apR = [new Allpass(sr, 5.3, 0.5), new Allpass(sr, 4.5, 0.5), new Allpass(sr, 3.8, 0.5)];
    this.preSize = Math.max(2, Math.floor(0.012 * sr));
    this.preBufL = new Float32Array(this.preSize);
    this.preBufR = new Float32Array(this.preSize);
    this.preIdx = 0;
    this.lpL = new OnePole();
    this.lpR = new OnePole();
    this.outL = 0;
    this.outR = 0;
  }
  /** 清空全部延迟线：混响/延迟是长反馈回路，一旦吃到 NaN 会永久静音 */
  reset() {
    for (const c of this.combsL) c.reset();
    for (const c of this.combsR) c.reset();
    for (const a of this.apL) a.reset();
    for (const a of this.apR) a.reset();
    this.preBufL.fill(0);
    this.preBufR.fill(0);
    this.preIdx = 0;
    this.lpL = new OnePole();
    this.lpR = new OnePole();
    this.outL = 0;
    this.outR = 0;
  }
  run(inL, inR) {
    const preL = this.preBufL[this.preIdx];
    const preR = this.preBufR[this.preIdx];
    this.preBufL[this.preIdx] = inL;
    this.preBufR[this.preIdx] = inR;
    this.preIdx = (this.preIdx + 1) % this.preSize;

    let a = 0;
    let b = 0;
    for (let i = 0; i < 8; i++) {
      a += this.combsL[i].run(preL);
      b += this.combsR[i].run(preR);
    }
    a *= 0.125;
    b *= 0.125;
    a = this.apL[0].run(a);
    a = this.apL[1].run(a);
    a = this.apL[2].run(a);
    b = this.apR[0].run(b);
    b = this.apR[1].run(b);
    b = this.apR[2].run(b);
    const la = this.lpL.run(a, 0.72);
    const lb = this.lpR.run(b, 0.72);
    // 少量交叉混合，避免左右完全去相关造成空洞感
    this.outL = la + lb * 0.12;
    this.outR = lb + la * 0.12;
  }
}

class DelayFx {
  constructor(sr, ms) {
    this.size = Math.max(2, Math.floor((ms / 1000) * sr));
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.idx = 0;
    this.lpL = 0;
    this.lpR = 0;
    this.outL = 0;
    this.outR = 0;
  }
  reset() {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.idx = 0;
    this.lpL = 0;
    this.lpR = 0;
    this.outL = 0;
    this.outR = 0;
  }
  run(inL, inR, fb) {
    const rawL = this.bufL[this.idx];
    const rawR = this.bufR[this.idx];
    // 反馈回路里加入高频阻尼，回声会自然变暗而不是金属感
    this.lpL += (rawL - this.lpL) * 0.72;
    this.lpR += (rawR - this.lpR) * 0.72;
    this.bufL[this.idx] = inL + this.lpR * fb;
    this.bufR[this.idx] = inR + this.lpL * fb;
    this.idx = (this.idx + 1) % this.size;
    this.outL = rawL;
    this.outR = rawR;
  }
}

// ----------------------------------------------------------------------------
// instrument presets defaults
// ----------------------------------------------------------------------------
const TYPE_DEFAULTS = {
  ep: {
    index: 2.0, tine: 0.45, decay: 1.4, sustain: 0.22, release: 0.35,
    tone: 0.82, drive: 0.05, chorus: 0.0, attack: 0.003, octave: 0,
  },
  piano: {
    brightness: 0.55, decay: 1.6, sustain: 0.28, release: 0.45,
    tone: 0.86, drive: 0.02, chorus: 0.0, attack: 0.004, octave: 0,
  },
  guitar: {
    damping: 0.42, bright: 0.52, drive: 0.03, chorus: 0.0, octave: 0,
  },
  synth: {
    wave: 0, cutoff: 900, resonance: 0.35, drive: 0.12, detune: 7, sub: 0.2,
    attack: 0.02, decay: 0.4, sustain: 0.35, release: 0.35, filterEnv: 0.55,
    lfoRate: 3.2, lfoDepth: 0.0, tremolo: 0.0, octave: 0, tone: 0.95, chorus: 0.0,
    pulseWidth: 0.5,
  },
  bass: {
    wave: 0, cutoff: 420, resonance: 0.3, drive: 0.18, detune: 3, sub: 0.55,
    attack: 0.006, decay: 0.28, sustain: 0.3, release: 0.2, filterEnv: 0.7,
    lfoRate: 1.2, lfoDepth: 0.0, tremolo: 0.0, octave: -12, tone: 0.9, chorus: 0.0,
    pulseWidth: 0.5,
  },
  drum: {
    punch: 0.6, decay: 0.45, tone: 0.6, toneShift: 0.5, drive: 0.1, chorus: 0.0,
  },
};

function defaultParams(type) {
  return Object.assign({}, TYPE_DEFAULTS[type] || TYPE_DEFAULTS.synth);
}

/**
 * 只保留有限数值的参数。缺失、undefined 或 NaN 一律丢弃，避免把这些值写进
 * 平滑目标后污染滤波器系数（典型的“界面看着在播，但一直没声音”）。
 */
function sanitizeParams(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

const DRUM_MAP = {
  35: 'kick', 36: 'kick', 38: 'snare', 41: 'tom', 45: 'tom',
  42: 'hat', 44: 'openhat', 46: 'openhat', 49: 'clap', 50: 'shaker',
  51: 'crash', 55: 'perc', 56: 'perc',
};

// ----------------------------------------------------------------------------
// voices
// ----------------------------------------------------------------------------
class Voice {
  constructor(sr, track, pitch, velocity, noteId, articulation, seed) {
    this.sr = sr;
    this.track = track;
    this.pitch = pitch;
    this.velocity = velocity;
    this.noteId = noteId;
    this.articulation = articulation || 'normal';
    this.rng = new RNG(seed);
    this.samples = 0;
    this.durSamples = Infinity;
    this.released = false;
    this.done = false;
    this.env = new Env(sr);
  }
  setDuration(frames) {
    if (frames > 0) this.durSamples = frames;
  }
  release() {
    if (!this.released) {
      this.released = true;
      this.env.release();
    }
  }
  /** 弯音：按半音偏移重算振子增量；鼓机无音高，沿用空实现 */
  retune() {}
}

class EpVoice extends Voice {
  constructor(sr, track, pitch, velocity, noteId, art, seed) {
    super(sr, track, pitch, velocity, noteId, art, seed);
    const p = track.p;
    const vel = velocity;
    this.f0 = mtof(pitch + (p.octave || 0));
    this.env.config(Math.max(0.0018, p.attack || 0.003), p.decay, clamp(p.sustain, 0.02, 1), p.release);
    this.env.trigger();
    this.ampScale = 0.26 + 0.64 * vel;
    // 双调制器 FM：1:1 调制提供琴体，2:1 调制提供金属“齿音”
    this.idx1 = (0.8 + vel * 2.6) * p.index;
    this.idx2 = (0.12 + vel * 1.1) * p.index * (0.3 + p.tine * 0.8);
    this.dec1 = Math.exp(-1 / (0.23 * sr));
    this.dec2 = Math.exp(-1 / (0.045 * sr));
    this.tineAmt = p.tine * (0.2 + 0.8 * vel);
    this.tineEnv = 1;
    this.tineDec = Math.exp(-1 / (0.11 * sr));
    const detune = (this.rng.next() - 0.5) * 0.9;
    this.f0 *= Math.pow(2, detune / 1200);
    this.baseF0 = this.f0;
    this.dPhase = this.f0 / sr;
    this.m1Phase = this.f0 / sr;
    this.m2Phase = (this.f0 * 2) / sr;
    this.tinePhase = 0;
    this.carrierP = 0;
    this.mod1P = 0;
    this.mod2P = 0;
    this.knock = (0.18 + 0.4 * vel) * (0.4 + 0.6 * p.tine);
    this.knockDec = Math.exp(-1 / (0.008 * sr));
    this.knockLP = 0;
  }
  retune(semi) {
    this.f0 = this.baseF0 * Math.pow(2, semi / 12);
    this.dPhase = this.f0 / this.sr;
  }
  renderTo(buf, n) {
    for (let i = 0; i < n; i++) {
      if (this.env.stage === 0) {
        this.done = true;
        break;
      }
      const env = this.env.tick();
      this.idx1 *= this.dec1;
      this.idx2 *= this.dec2;
      this.tineEnv *= this.tineDec;
      this.knock *= this.knockDec;
      this.knockLP += (this.rng.bipolar() - this.knockLP) * 0.55;
      const m1 = Math.sin(TWO_PI * this.mod1P);
      const m2 = Math.sin(TWO_PI * this.mod2P);
      let body = Math.sin(TWO_PI * this.carrierP + this.idx1 * m1 + this.idx2 * m2);
      body = tanhFast(body * 1.12) * 0.94;
      const tine = Math.sin(TWO_PI * this.tinePhase) * this.tineEnv * this.tineAmt * 0.26;
      const knock = this.knockLP * this.knock * 0.4;
      buf[i] += (body * env * this.ampScale + tine + knock);
      this.carrierP += this.dPhase;
      if (this.carrierP >= 1) this.carrierP -= 1;
      this.mod1P += this.dPhase;
      if (this.mod1P >= 1) this.mod1P -= 1;
      this.mod2P += this.dPhase * 2;
      if (this.mod2P >= 1) this.mod2P -= 1;
      this.tinePhase += this.dPhase * 3;
      if (this.tinePhase >= 1) this.tinePhase -= 1;
      this.samples++;
      if (!this.released && this.samples >= this.durSamples) this.release();
    }
  }
}

class PianoVoice extends Voice {
  constructor(sr, track, pitch, velocity, noteId, art, seed) {
    super(sr, track, pitch, velocity, noteId, art, seed);
    const p = track.p;
    this.f0 = mtof(pitch + (p.octave || 0));
    this.env.config(Math.max(0.0015, p.attack || 0.004), p.decay, clamp(p.sustain, 0.02, 1), p.release);
    this.env.trigger();
    this.bright = clamp(p.brightness, 0, 1);
    // 7 个非线性泛音：比 5 个更饱满、更接近真实钢琴的弦列；下方归一化后总电平不变
    this.partials = 7;
    this.phases = [0, 0, 0, 0, 0, 0, 0];
    this.amps = [0, 0, 0, 0, 0, 0, 0];
    this.dec = [1, 1, 1, 1, 1, 1, 1];
    this.inc = [0, 0, 0, 0, 0, 0, 0];
    this.ratios = [1, 1, 1, 1, 1, 1, 1];
    this.baseF0 = this.f0;
    // 钢琴弦的非谐性随音高上升；高次泛音衰减更快，这是“像钢琴”的关键
    const inh = 0.00012 + 0.00048 * clamp((pitch - 24) / 72, 0, 1);
    const bright = this.bright;
    let norm = 0;
    for (let k = 0; k < this.partials; k++) {
      const n = k + 1;
      const ratio = n * Math.sqrt(1 + inh * n * n);
      this.ratios[k] = ratio;
      const f = this.f0 * ratio;
      this.inc[k] = f / sr;
      const velTilt = n === 1 ? 1 : Math.pow(velocity, 1.15);
      let amp = Math.pow(n, -1.22) * (0.55 + bright * 0.95) * velTilt;
      this.amps[k] = amp;
      norm += amp;
      const tau = clamp(p.decay, 0.2, 4) / (1 + 0.5 * (n - 1)) * (0.72 + 0.55 * velocity);
      this.dec[k] = Math.exp(-1 / (tau * sr));
      this.phases[k] = this.rng.next();
    }
    const inv = 1 / Math.max(1.15, norm);
    for (let k = 0; k < this.partials; k++) this.amps[k] *= inv;
    this.ampScale = (0.3 + 0.7 * velocity) * 0.78;
    // 琴槌触弦的短促噪声，让音头有真实“触感”
    this.hammer = (0.1 + 0.32 * velocity) * (0.35 + bright * 0.65);
    this.hammerDec = Math.exp(-1 / (0.016 * sr));
    this.hammerLP = 0;
  }
  retune(semi) {
    const r = Math.pow(2, semi / 12);
    for (let k = 0; k < this.partials; k++) this.inc[k] = (this.baseF0 * this.ratios[k] * r) / this.sr;
  }
  renderTo(buf, n) {
    for (let i = 0; i < n; i++) {
      if (this.env.stage === 0) {
        this.done = true;
        break;
      }
      const env = this.env.tick();
      this.hammer *= this.hammerDec;
      this.hammerLP += (this.rng.bipolar() - this.hammerLP) * 0.35;
      let s = this.hammerLP * this.hammer * 0.42;
      for (let k = 0; k < this.partials; k++) {
        this.phases[k] += this.inc[k];
        if (this.phases[k] >= 1) this.phases[k] -= 1;
        this.amps[k] *= this.dec[k];
        s += Math.sin(TWO_PI * this.phases[k]) * this.amps[k];
      }
      buf[i] += s * env * this.ampScale;
      this.samples++;
      if (!this.released && this.samples >= this.durSamples) this.release();
    }
  }
}

class GuitarVoice extends Voice {
  constructor(sr, track, pitch, velocity, noteId, art, seed) {
    super(sr, track, pitch, velocity, noteId, art, seed);
    const p = track.p;
    this.f0 = mtof(pitch + (p.octave || 0));
    const detune = (this.rng.next() - 0.5) * 6;
    this.f0 *= Math.pow(2, detune / 1200);
    this.baseF0 = this.f0;
    const mute = art === 'mute';
    this.mute = mute;
    this.bright = clamp(p.bright, 0.05, 1);
    this.size = 4096;
    this.mask = 4095;
    this.buf = new Float32Array(4096);
    this.write = 0;
    this.loopLP = 0;
    // 环路低通：亮度越高，高频保留越久
    this.loopB = mute ? 0.72 : 0.14 + (1 - this.bright) * 0.5;
    const decayT = mute ? 0.06 : lerp(3.2, 0.35, clamp(p.damping, 0, 1));
    this.decayT = decayT;
    this.g = Math.exp(-1 / (Math.max(0.02, decayT) * this.f0));
    const period = sr / this.f0;
    // 用环路滤波群延时补偿，避免音高偏低
    this.delay = clamp(period - (1 - this.loopB) / this.loopB, 6, 4078);
    this.strength = 0.22 + 0.78 * velocity;
    this.env.config(0.001, 0, 1, mute ? 0.035 : 0.11);
    this.env.trigger();
    this.env.v = 1;
    this.env.stage = 3;
    this.pick = new OnePole();
    this.bodyLP = new OnePole();
    this.dc = new DCBlock();
    this.toneA = (0.12 + this.bright * 0.72) * (0.72 + 0.4 * velocity);
    this.outGain = mute ? 0.7 : 1.02;

    // 拨弦激励：带梳状陷波的噪声 + 一个周期正弦，兼顾拨奏纹理与明确音高
    const exciteLen = Math.max(12, Math.floor(period * 1.15));
    const comb = Math.max(1, Math.floor(period * (0.1 + this.rng.next() * 0.14)));
    const nbuf = new Float32Array(exciteLen);
    const pickLP = lerp(0.22, 0.9, this.bright);
    let lp = 0;
    for (let i = 0; i < exciteLen; i++) {
      const t = i / exciteLen;
      const nz = this.rng.bipolar();
      lp += (nz - lp) * pickLP;
      nbuf[i] = lp;
      const early = i >= comb ? nbuf[i - comb] : 0;
      const shaped = (lp - early * 0.82) * Math.pow(1 - t, mute ? 1.6 : 0.9);
      const sine = Math.sin(TWO_PI * this.f0 * (i / sr)) * Math.pow(1 - t, 1.35) * 0.55;
      this.buf[i & this.mask] = (shaped * 0.6 + sine) * this.strength;
    }
    this.write = exciteLen & this.mask;
  }
  retune(semi) {
    const f = this.baseF0 * Math.pow(2, semi / 12);
    this.f0 = f;
    // 环路增益随基频变化，保持衰减时间不变；延迟长度决定音高
    this.g = Math.exp(-1 / (Math.max(0.02, this.decayT) * f));
    const period = this.sr / f;
    this.delay = clamp(period - (1 - this.loopB) / this.loopB, 6, 4078);
  }
  renderTo(buf, n) {
    const mask = this.mask;
    for (let i = 0; i < n; i++) {
      let readPos = this.write - this.delay;
      if (readPos < 0) readPos += 4096;
      let i0 = Math.floor(readPos);
      const frac = readPos - i0;
      const s0 = this.buf[i0 & mask];
      const s1 = this.buf[(i0 + 1) & mask];
      const s = s0 + (s1 - s0) * frac;
      // 环路阻尼（一阶低通）
      this.loopLP += (s - this.loopLP) * this.loopB;
      this.buf[this.write & mask] = this.loopLP * this.g;
      this.write = (this.write + 1) & mask;

      let out = s * this.outGain;
      out += this.bodyLP.run(s, 0.035) * 0.38;
      out = this.pick.run(out, this.toneA);
      out = this.dc.run(out);
      if (this.released) {
        this.env.v *= this.env.relCoef;
        if (this.env.v < 0.01) {
          this.done = true;
          break;
        }
        out *= this.env.v;
      }
      buf[i] += out;
      this.samples++;
      if (!this.released && this.samples >= this.durSamples) this.release();
    }
  }
}

class SynthVoice extends Voice {
  constructor(sr, track, pitch, velocity, noteId, art, seed) {
    super(sr, track, pitch, velocity, noteId, art, seed);
    const p = track.p;
    this.f0 = mtof(pitch + (p.octave || 0));
    this.baseF0 = this.f0;
    this.env.config(Math.max(0.001, p.attack), p.decay, clamp(p.sustain, 0.01, 1), p.release);
    this.env.trigger();
    this.ampScale = 0.34 + 0.66 * velocity;
    // 三个失谐振荡器叠成小型的 unison 组；对称失谐 + 固定错相，
    // 保证任何时刻基频都不会被随机相位抵消（否则测音与听感都会出现倍频假象）
    this.voiceCount = 3;
    this.det = [-p.detune, 0, p.detune];
    this.oscP = [0, 0.25, 0.75];
    this.subP = 0;
    this.lfoP = this.rng.next();
    this.f1 = new SVF();
    this.f2 = new SVF();
    this.dc = new DCBlock();
  }
  retune(semi) {
    this.f0 = this.baseF0 * Math.pow(2, semi / 12);
  }
  renderOsc(phase, dt, wave, pw) {
    if (wave === 1) {
      let v = phase < pw ? 1 : -1;
      v += blep(phase, dt);
      let p2 = phase + 1 - pw;
      if (p2 >= 1) p2 -= 1;
      v -= blep(p2, dt);
      return v;
    }
    return 2 * phase - 1 - blep(phase, dt);
  }
  renderTo(buf, n) {
    const p = this.track.p;
    const baseCut = p.cutoff;
    const k = 1 / (0.55 + p.resonance * 9.5);
    const lfoRate = p.lfoRate;
    const vibCents = p.lfoDepth * 42;
    const wave = p.wave;
    const pw = p.pulseWidth;
    const drive = p.drive;
    const subAmt = p.sub || 0;
    const det = this.det;
    const oscP = this.oscP;
    const ampScale = this.ampScale;
    let g = svfG(baseCut, this.sr);
    let gTarget = g;
    const dt0 = this.f0 / this.sr;
    for (let i = 0; i < n; i++) {
      if (this.env.stage === 0) {
        this.done = true;
        break;
      }
      const env = this.env.tick();
      this.lfoP += lfoRate / this.sr;
      if (this.lfoP >= 1) this.lfoP -= 1;
      const lfo = Math.sin(TWO_PI * this.lfoP);
      const vib = 1 + (lfo * vibCents) / 1200;
      let mix = 0;
      for (let o = 0; o < this.voiceCount; o++) {
        const dt = dt0 * vib * Math.pow(2, det[o] / 1200);
        mix += this.renderOsc(oscP[o], dt, wave, pw);
        oscP[o] += dt;
        if (oscP[o] >= 1) oscP[o] -= 1;
      }
      mix *= 0.333;
      const sub = Math.sin(TWO_PI * this.subP) * subAmt * 0.62;
      this.subP += dt0 * 0.5 * vib;
      if (this.subP >= 1) this.subP -= 1;
      mix += sub;

      if ((i & 15) === 0) {
        // 滤波包络：指数映射，避免参数推满时变成开关式的突变
        const fc = baseCut * Math.pow(2, p.filterEnv * 3.4 * env);
        gTarget = svfG(fc, this.sr);
      }
      // 对滤波器系数逐采样平滑，抹平每 16 样本更新留下的阶梯（zipper）噪声
      g += (gTarget - g) * 0.15;
      let s = this.f1.run(mix, g, k);
      s = this.f2.run(s, g, k * 1.28);
      s = tanhFast(s * (1 + drive * 3.4)) * (1 - drive * 0.32);
      s = this.dc.run(s);
      let amp = env * ampScale;
      if (p.tremolo > 0) amp *= 1 - p.tremolo * 0.52 * (0.5 + 0.5 * lfo);
      buf[i] += s * amp;
      this.samples++;
      if (!this.released && this.samples >= this.durSamples) this.release();
    }
  }
}

class DrumVoice extends Voice {
  constructor(sr, track, pitch, velocity, noteId, art, seed) {
    super(sr, track, pitch, velocity, noteId, art, seed);
    const p = track.p;
    this.piece = DRUM_MAP[pitch] || 'perc';
    this.vel = velocity;
    this.punch = clamp(p.punch ?? 0.5, 0, 1);
    this.decay = clamp(p.decay ?? 0.5, 0, 1);
    this.toneShift = clamp(p.toneShift ?? 0.5, 0, 1);
    this.t = 0;
    this.dur = 0;
    this.phase = 0;
    this.phase2 = 0;
    this.svfA = new SVF();
    this.svfB = new SVF();
    const scale = 1 + (this.toneShift - 0.5) * 0.42;

    // 808 风格的 6 方波金属振荡器，用于 hat / openhat / crash
    this.mPh = new Float32Array(6);
    this.mDt = new Float32Array(6);
    const METAL = [0.79, 1.0, 1.13, 1.42, 1.79, 2.31];
    const base = this.piece === 'crash' ? 640 * scale : this.piece === 'openhat' ? 1560 * scale : 1720 * scale;
    for (let k = 0; k < 6; k++) {
      this.mPh[k] = this.rng.next();
      this.mDt[k] = (base * METAL[k]) / sr;
    }

    if (this.piece === 'kick') {
      this.dur = 0.22 + this.decay * 0.58;
      this.fStart = (210 + this.punch * 110) * scale;
      this.fEnd = 44 * scale;
    } else if (this.piece === 'snare') {
      this.dur = 0.12 + this.decay * 0.42;
      this.toneF = (160 + this.punch * 45) * scale;
      this.toneF2 = 320 * scale;
    } else if (this.piece === 'hat') {
      this.dur = 0.05 + this.decay * 0.12;
    } else if (this.piece === 'openhat') {
      this.dur = 0.2 + this.decay * 0.55;
    } else if (this.piece === 'clap') {
      this.dur = 0.16 + this.decay * 0.32;
    } else if (this.piece === 'tom') {
      this.dur = 0.18 + this.decay * 0.42;
      this.fStart = 340 * scale;
      this.fEnd = 96 * scale;
    } else if (this.piece === 'shaker') {
      this.dur = 0.08 + this.decay * 0.18;
    } else if (this.piece === 'crash') {
      this.dur = 0.5 + this.decay * 1.15;
    } else {
      this.dur = 0.14 + this.decay * 0.36;
      this.toneF = 300 * scale;
    }
  }
  renderTo(buf, n) {
    const sr = this.sr;
    const velGain = 0.4 + 0.6 * this.vel;
    for (let i = 0; i < n; i++) {
      if (this.t >= this.dur) {
        this.done = true;
        break;
      }
      const tt = this.t;
      let s = 0;
      if (this.piece === 'kick') {
        // 三段：低频主体 + 二次谐波冲击 + 槌头敲击噪声
        const f = this.fEnd + (this.fStart - this.fEnd) * Math.exp(-tt * 26);
        this.phase += f / sr;
        if (this.phase >= 1) this.phase -= 1;
        const env = Math.exp(-tt * (6 + (1 - this.decay) * 9));
        const body = Math.sin(TWO_PI * this.phase) + 0.16 * Math.sin(TWO_PI * this.phase * 2) * Math.exp(-tt * 30);
        const click = this.svfA.run(this.rng.bipolar(), svfG(2800, sr), 0.7);
        s = body * env * (1.02 + this.punch * 0.5) + this.svfA.high * Math.exp(-tt * 150) * this.punch * 0.7;
        s = tanhFast(s * 1.3) * 0.86;
      } else if (this.piece === 'snare') {
        const nz = this.rng.bipolar();
        this.svfA.run(nz, svfG(880, sr), 0.7);
        const hp = this.svfA.high;
        this.svfB.run(hp, svfG(2400 + this.toneShift * 1900, sr), 0.55);
        const noise = (this.svfB.band * 0.85 + hp * 0.45) * Math.exp(-tt * (10 + (1 - this.decay) * 14));
        this.phase += this.toneF / sr;
        if (this.phase >= 1) this.phase -= 1;
        this.phase2 += this.toneF2 / sr;
        if (this.phase2 >= 1) this.phase2 -= 1;
        const tone = Math.sin(TWO_PI * this.phase) * Math.exp(-tt * 26) * 0.34
          + Math.sin(TWO_PI * this.phase2) * Math.exp(-tt * 42) * 0.15;
        const crack = this.rng.bipolar() * Math.exp(-tt * 170) * this.punch * 0.4;
        s = tanhFast((noise * 1.25 + tone + crack) * 1.15) * 0.8;
      } else if (this.piece === 'hat' || this.piece === 'openhat' || this.piece === 'crash') {
        let m = 0;
        for (let k = 0; k < 6; k++) {
          const ph = this.mPh[k];
          const dt = this.mDt[k];
          let sq = ph < 0.5 ? 1 : -1;
          sq += blep(ph, dt);
          let ph2 = ph + 0.5;
          if (ph2 >= 1) ph2 -= 1;
          sq -= blep(ph2, dt);
          m += sq;
          let np = ph + dt;
          if (np >= 1) np -= 1;
          this.mPh[k] = np;
        }
        this.svfA.run(m * 0.1667, svfG(this.piece === 'crash' ? 2400 : 3200, sr), 0.8);
        let metal = this.svfA.high;
        this.svfB.run(this.rng.bipolar(), svfG(9200, sr), 0.6);
        metal += this.svfB.high * 0.5;
        const rate = this.piece === 'hat' ? 42 + (1 - this.decay) * 32
          : this.piece === 'openhat' ? 9 + (1 - this.decay) * 9
            : 4.2;
        s = metal * Math.exp(-tt * rate) * (0.56 + this.punch * 0.4);
      } else if (this.piece === 'clap') {
        this.svfA.run(this.rng.bipolar(), svfG(2100, sr), 1.0);
        let env = 0;
        for (let b = 0; b < 3; b++) {
          const local = tt - b * 0.012;
          if (local > 0) env += Math.exp(-local * 95);
        }
        const tail = tt - 0.036;
        if (tail > 0) env += Math.exp(-tail * 26) * 1.35;
        s = (this.svfA.band * 1.5 + this.svfA.high * 0.25) * env;
      } else if (this.piece === 'tom') {
        const f = this.fEnd + (this.fStart - this.fEnd) * Math.exp(-tt * 16);
        this.phase += f / sr;
        if (this.phase >= 1) this.phase -= 1;
        const body = Math.sin(TWO_PI * this.phase) * Math.exp(-tt * (7 + (1 - this.decay) * 9));
        const nz = this.svfA.run(this.rng.bipolar(), svfG(1400, sr), 0.6);
        s = body * 1.1 + nz * Math.exp(-tt * 90) * 0.25 * this.punch;
      } else if (this.piece === 'shaker') {
        const nz = this.rng.bipolar();
        this.svfA.run(nz, svfG(7200, sr), 0.5);
        const ripple = Math.exp(-tt * 34) * (0.55 + 0.45 * Math.cos(TWO_PI * 190 * tt));
        s = this.svfA.high * ripple * 0.95;
      } else {
        const nz = this.rng.bipolar();
        this.svfA.run(nz, svfG(1100 + this.toneShift * 1800, sr), 0.6);
        this.phase += this.toneF / sr;
        if (this.phase >= 1) this.phase -= 1;
        s = (this.svfA.band * 0.7 + Math.sin(TWO_PI * this.phase) * 0.55) * Math.exp(-tt * 16);
      }
      buf[i] += s * velGain;
      this.t += 1 / sr;
      this.samples++;
    }
  }
}

// ----------------------------------------------------------------------------
// audio voice（WAV 素材轨）
// ----------------------------------------------------------------------------
/**
 * 素材按原生采样率存入，播放时线性插值重采样到工作采样率。
 * 片段边界做 5ms 淡入淡出，避免切点爆音；释音（停止/跳转）走同样的淡出。
 */
class AudioVoice {
  constructor(sr, track, asset, offsetSec, durFrames, gain, id, src, gen) {
    this.sr = sr;
    this.track = track;
    this.channels = asset.channels;
    this.ratio = asset.sampleRate / sr;
    this.pos = Math.max(0, (offsetSec || 0) * asset.sampleRate);
    this.length = asset.channels[0] ? asset.channels[0].length : 0;
    this.frame = 0;
    this.frames = durFrames > 0 ? durFrames : Infinity;
    this.gain = clamp(gain == null ? 1 : gain, 0, 2);
    this.id = id;
    this.src = src || 'transport';
    this.gen = gen;
    this.done = false;
    this.releasing = false;
    this.releaseLeft = 0;
    const seconds = this.frames === Infinity ? 0.005 : Math.min(0.005, (this.frames / sr) * 0.5);
    this.fadeFrames = Math.max(1, Math.round(seconds * sr));
  }
  release() {
    if (this.done || this.releasing) return;
    this.releasing = true;
    this.releaseLeft = this.fadeFrames;
  }
  renderTo(outL, outR, n) {
    const ch0 = this.channels[0];
    if (!ch0 || !this.length) {
      this.done = true;
      return;
    }
    const ch1 = this.channels.length > 1 ? this.channels[1] : ch0;
    for (let i = 0; i < n && !this.done; i++) {
      if (this.frame >= this.frames) {
        this.done = true;
        break;
      }
      const p = this.pos;
      const i0 = Math.floor(p);
      if (i0 >= this.length) {
        this.done = true;
        break;
      }
      const i1 = i0 + 1 < this.length ? i0 + 1 : i0;
      const f = p - i0;
      let g = this.gain;
      if (this.frame < this.fadeFrames) g *= this.frame / this.fadeFrames;
      const left = this.frames - this.frame;
      if (left < this.fadeFrames) g *= left / this.fadeFrames;
      if (this.releasing) {
        g *= this.releaseLeft / this.fadeFrames;
        this.releaseLeft--;
        if (this.releaseLeft <= 0) this.done = true;
      }
      const sL = ch0[i0] + (ch0[i1] - ch0[i0]) * f;
      const sR = ch1[i0] + (ch1[i1] - ch1[i0]) * f;
      outL[i] += sL * g;
      outR[i] += sR * g;
      this.pos += this.ratio;
      this.frame++;
    }
    if (this.frames !== Infinity && this.frame >= this.frames) this.done = true;
  }
}

// ----------------------------------------------------------------------------
// track
// ----------------------------------------------------------------------------
/**
 * 采样音源声部：按音高选最近采样、线性插值变调，有循环点时循环到采样结束。
 * 采样以 Int16 存放，渲染时才换算成浮点，避免整库 Float32 占满音频线程内存。
 */
class SampleVoice extends Voice {
  constructor(sr, track, pitch, velocity, noteId, art, seed, sample) {
    super(sr, track, pitch, velocity, noteId, art, seed);
    this.data = sample.data;
    this.rate = Math.pow(2, (pitch - sample.pitch) / 12) * (sample.sampleRate / sr);
    this.baseRate = this.rate;
    this.pos = 0;
    this.loopStart = sample.loopStart;
    this.loopEnd = sample.loopEnd;
    this.loopLen = Math.max(1, this.loopEnd - this.loopStart);
    this.velGain = 0.78 + 0.22 * velocity;
    // 力度差已由采样层表决定，这里只补一层轻微包络，避免同层不同力度完全同响度
    this.env.config(0.004, 0, 1, 0.14);
    this.env.trigger();
    this.piece = DRUM_MAP[pitch] || null;
  }
  retune(semi) {
    this.rate = this.baseRate * Math.pow(2, semi / 12);
  }
  renderTo(buf, n) {
    const d = this.data;
    const last = d.length - 1;
    for (let i = 0; i < n; i++) {
      if (this.env.stage === 0) {
        this.done = true;
        break;
      }
      const env = this.env.tick();
      let p = this.pos;
      if (p >= last) {
        this.done = true;
        break;
      }
      const i0 = p | 0;
      const f = p - i0;
      const s = (d[i0] + (d[i0 + 1] - d[i0]) * f) * 3.0517578125e-5;
      buf[i] += s * env * this.velGain;
      this.pos = p + this.rate;
      if (this.loopEnd > 0 && this.pos >= this.loopEnd) {
        this.pos = this.loopStart + ((this.pos - this.loopEnd) % this.loopLen);
      }
      this.samples++;
      if (!this.released && this.samples >= this.durSamples) this.release();
    }
    if (this.pos >= last) this.done = true;
  }
}

class Track {
  constructor(sr, index, owner) {
    this.sr = sr;
    this.index = index;
    this.owner = owner || null;
    this.type = 'synth';
    this.p = defaultParams('synth');
    this.target = Object.assign({}, this.p);
    this.voices = [];
    /** 采样音源库 id；非空时优先用采样发声，库未加载或超出覆盖范围则回退合成音源 */
    this.sampleBank = null;
    this.volume = 1;
    this.volumeTarget = 1;
    this.pan = 0;
    this.panTarget = 0;
    this.mute = false;
    this.solo = false;
    this.sendRev = 0.2;
    this.sendRevTarget = 0.2;
    this.sendDelay = 0;
    this.sendDelayTarget = 0;
    this.toneLP = 0.95;
    this.toneS = 0.95;
    this.drive = 0.05;
    this.driveS = 0.05;
    this.chorus = 0;
    this.chorusS = 0;
    this.lpL = 0;
    this.lpR = 0;
    this.panGain = [1, 1];
    this.chorusBufL = new Float32Array(8192);
    this.chorusBufR = new Float32Array(8192);
    this.chorusIdx = 0;
    this.chorusPhase = 0;
    this.mono = new Float32Array(128);
    // 音频轨（WAV 素材）：独立立体声缓冲，与合成声部相加后走音量/声像/发送
    this.audioVoices = [];
    this.audioL = new Float32Array(128);
    this.audioR = new Float32Array(128);
    this.peak = 0;
    // 弯音（半音，±2）与触后（0–1）都是通道级实时表情，平滑过渡避免拉链噪声
    this.bend = 0;
    this.bendTarget = 0;
    this.appliedBend = 0;
    this.pressure = 0;
    this.pressureTarget = 0;
  }
  setBend(v) {
    this.bendTarget = clamp(v, -2, 2);
  }
  setPressure(v) {
    this.pressureTarget = clamp(v, 0, 1);
  }
  setType(type) {
    this.type = type;
    this.p = defaultParams(type);
    this.target = Object.assign({}, this.p);
    for (const v of this.voices) v.release();
  }
  hasActiveVoices() {
    for (const v of this.voices) if (!v.done) return true;
    return false;
  }
  setParams(partial) {
    const clean = sanitizeParams(partial);
    if (!clean) return;
    Object.assign(this.target, clean);
    // 没有发声声部时不存在需要淡出的过渡，直接生效；
    // 否则下一个音会用旧参数起音（预设试听的第一个音、切换音色后的第一个音都会失真）
    if (!this.hasActiveVoices()) Object.assign(this.p, clean);
  }
  smooth() {
    const sp = 0.1;
    for (const k in this.target) {
      const tv = this.target[k];
      const cv = this.p[k];
      if (typeof cv === 'number' && typeof tv === 'number') this.p[k] = cv + (tv - cv) * sp;
      else this.p[k] = tv;
    }
    this.volume += (this.volumeTarget - this.volume) * 0.1;
    this.pan += (this.panTarget - this.pan) * 0.1;
    this.sendRev += (this.sendRevTarget - this.sendRev) * 0.1;
    this.sendDelay += (this.sendDelayTarget - this.sendDelay) * 0.1;
    this.toneS += (this.toneLP - this.toneS) * 0.1;
    this.driveS += (this.drive - this.driveS) * 0.1;
    this.chorusS += (this.chorus - this.chorusS) * 0.1;
    this.bend += (this.bendTarget - this.bend) * 0.25;
    if (Math.abs(this.bendTarget - this.bend) < 0.0004) this.bend = this.bendTarget;
    // 只在弯音真正变化时重算振子增量（钢琴 5 个泛音 × 最多 24 声部，代价可控）
    if (this.bend !== this.appliedBend) {
      for (const v of this.voices) if (!v.done) v.retune(this.bend);
      this.appliedBend = this.bend;
    }
    this.pressure += (this.pressureTarget - this.pressure) * 0.12;
    const a = (clamp(this.pan, -1, 1) + 1) * Math.PI * 0.25;
    this.panGain[0] = Math.cos(a) * Math.SQRT2;
    this.panGain[1] = Math.sin(a) * Math.SQRT2;
  }
  /** 按音高与力度挑选采样：力度层优先，音高取最近根音；鼓组要求同键位 */
  pickSample(pitch, velocity) {
    const id = this.sampleBank;
    if (!id || !this.owner) return null;
    const bank = this.owner.banks.get(id);
    if (!bank || !bank.samples.length) return null;
    const drums = bank.kind === 'drums';
    let best = null;
    let bestDist = Infinity;
    for (const s of bank.samples) {
      if (velocity < s.velMin - 1e-6 || velocity > s.velMax + 1e-6) continue;
      const dist = Math.abs(s.pitch - pitch);
      if (drums) {
        if (dist <= 1 && dist < bestDist) {
          bestDist = dist;
          best = s;
        }
      } else if (dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    // 采样库覆盖不到这个音高时退回合成音源，避免整轨静音
    if (!best) {
      // 该音高只有单层采样时（部分低音/高音区），按音高最近 + 力度最接近补选，避免退化成合成音色
      let bestScore = Infinity;
      for (const s of bank.samples) {
        const dist = Math.abs(s.pitch - pitch);
        if (drums && dist > 1) continue;
        if (!drums && dist > 15) continue;
        const velDist = velocity < s.velMin ? s.velMin - velocity : velocity > s.velMax ? velocity - s.velMax : 0;
        const score = dist * 4 + velDist;
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
    }
    if (!best || (!drums && Math.abs(best.pitch - pitch) > 15)) return null;
    return best;
  }
  noteOn(pitch, velocity, noteId, articulation, durFrames, seed, src, gen) {
    // 音高/力度非法时不发声：NaN 会被乐器算式放大成整轨永久静音
    if (!Number.isFinite(pitch)) return null;
    const vel = clamp(finite(velocity, 0.7), 0, 1);
    const frames = Number.isFinite(durFrames) && durFrames > 0 ? durFrames : 0;
    const type = this.type;
    let v;
    const sample = this.pickSample(pitch, vel);
    if (sample) v = new SampleVoice(this.sr, this, pitch, vel, noteId, articulation, seed, sample);
    else if (type === 'ep') v = new EpVoice(this.sr, this, pitch, vel, noteId, articulation, seed);
    else if (type === 'guitar') v = new GuitarVoice(this.sr, this, pitch, vel, noteId, articulation, seed);
    else if (type === 'piano') v = new PianoVoice(this.sr, this, pitch, vel, noteId, articulation, seed);
    else if (type === 'drum') v = new DrumVoice(this.sr, this, pitch, vel, noteId, articulation, seed);
    else v = new SynthVoice(this.sr, this, pitch, vel, noteId, articulation, seed);
    if (!v) return null;
    if (type === 'drum' && (v.piece === 'hat' || v.piece === 'openhat' || v.piece === 'crash')) {
      for (const other of this.voices) {
        if (!other.released && (other.piece === 'hat' || other.piece === 'openhat')) other.done = true;
      }
    }
    v.src = src || 'transport';
    v.gen = gen;
    if (this.bend !== 0) v.retune(this.bend);
    v.setDuration(frames);
    if (this.voices.length >= 24) this.voices.shift();
    this.voices.push(v);
    return v;
  }
  noteOff(noteId) {
    for (const v of this.voices) if (v.noteId === noteId) v.release();
  }
  /** 只释放指定来源（且非当前代际）的声部，互不干扰 */
  releaseSource(src, gen) {
    for (const v of this.voices) {
      if (v.src === src && (gen === undefined || v.gen !== gen)) v.release();
    }
  }
  allNotesOff() {
    for (const v of this.voices) v.release();
  }
  audioOn(asset, offsetSec, durFrames, gain, id, src, gen) {
    if (!asset || !asset.channels || !asset.channels.length) return null;
    const v = new AudioVoice(this.sr, this, asset, offsetSec, durFrames, gain, id, src, gen);
    if (this.audioVoices.length >= 8) this.audioVoices.shift();
    this.audioVoices.push(v);
    return v;
  }
  releaseAudioSource(src, gen) {
    for (const v of this.audioVoices) {
      if (v.src === src && (gen === undefined || v.gen !== gen)) v.release();
    }
  }
  renderBlock(outL, outR, sendL, sendD, audible, n) {
    const sl = this.mono;
    const sr = this.sr;
    for (let i = 0; i < n; i++) sl[i] = 0;
    for (const v of this.voices) {
      if (!v.done) v.renderTo(sl, n);
    }
    if (this.voices.length) this.voices = this.voices.filter((v) => !v.done);
    const al = this.audioL;
    const ar = this.audioR;
    const hasAudio = this.audioVoices.length > 0;
    if (hasAudio) {
      for (let i = 0; i < n; i++) {
        al[i] = 0;
        ar[i] = 0;
      }
      for (const v of this.audioVoices) {
        if (!v.done) v.renderTo(al, ar, n);
      }
      this.audioVoices = this.audioVoices.filter((v) => !v.done);
    }
    if (!audible) {
      this.peak *= 0.85;
      return;
    }
    const toneA = Math.min(1, 0.02 + this.toneS * 0.75 + this.pressure * 0.18);
    const dr = this.driveS;
    const vol = this.volume;
    const pressGain = 1 + this.pressure * 0.3;
    const panL = Number.isFinite(this.panGain[0]) ? this.panGain[0] : 1;
    const panR = Number.isFinite(this.panGain[1]) ? this.panGain[1] : 1;
    const chorus = this.chorusS;
    const toneCoef = Number.isFinite(toneA) ? toneA : 1;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let mono = sl[i] * pressGain;
      // 单个声部算出 NaN 时只丢掉这一拍，不能让滤波器状态被污染成整轨永久静音
      if (!isFinite(mono)) mono = 0;
      this.lpL += (mono - this.lpL) * toneCoef;
      if (!isFinite(this.lpL)) this.lpL = 0;
      mono = this.lpL;
      if (dr > 0.02) mono = softsat(mono * (1 + dr * 4));
      let l = mono;
      let r = mono;
      if (chorus > 0.02) {
        const idx = this.chorusIdx;
        const d = Math.floor((0.006 + 0.0025 * Math.sin(TWO_PI * this.chorusPhase)) * sr);
        const read = this.chorusBufL[(idx - d + 8192) % 8192];
        this.chorusBufL[idx] = mono;
        this.chorusIdx = (idx + 1) % 8192;
        l = mono * (1 - chorus * 0.5) + read * chorus * 0.9;
        r = mono * (1 - chorus * 0.5) + read * chorus * 0.55;
        this.chorusPhase += 0.55 / sr;
        if (this.chorusPhase >= 1) this.chorusPhase -= 1;
      }
      if (hasAudio) {
        l += al[i];
        r += ar[i];
      }
      if (!isFinite(l)) l = 0;
      if (!isFinite(r)) r = 0;
      l *= panL * vol;
      r *= panR * vol;
      outL[i] += l;
      outR[i] += r;
      sendL[i] += (l + r) * 0.5 * this.sendRev;
      sendD[i] += (l + r) * 0.5 * this.sendDelay;
      const abs = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      if (abs > peak) peak = abs;
    }
    this.peak = Math.max(peak, this.peak * 0.7);
  }
}

// ----------------------------------------------------------------------------
// processor
// ----------------------------------------------------------------------------
const MAX_TRACKS = 16;

class StudioProcessor {
  constructor(options) {
    options = options || {};
    this.sr = options.sampleRate || sampleRate;
    this.blockLen = 128;
    this.tracks = [];
    for (let i = 0; i < MAX_TRACKS; i++) this.tracks.push(new Track(this.sr, i, this));
    /** 采样音源库：id → { kind, sampleRate, samples }，由主线程按需下发 */
    this.banks = new Map();
    this.outBufL = new Float32Array(this.blockLen);
    this.outBufR = new Float32Array(this.blockLen);
    this.sendL = new Float32Array(this.blockLen);
    this.sendD = new Float32Array(this.blockLen);
    this.reverb = new Reverb(this.sr);
    this.delay = new DelayFx(this.sr, 190);
    this.volume = 1;
    this.volumeTarget = 1;
    this.events = [];
    // 音频素材：id → { sampleRate, channels: Float32Array[] }
    this.assets = new Map();
    this.frame = 0;
    this.voiceSeed = 12345;
    this.clickPhase = 0;
    this.clicks = [];
    this.levelTimer = 0;
    this.masterPeak = 0;
    this.dcL = new DCBlock();
    this.dcR = new DCBlock();
    // 自动恢复次数：主线程据此提示“引擎已自愈”，而不是静默失声
    this.recoveries = 0;
    this._pendingMessages = [];
    this.postMessage = options.post || (() => {});
  }
  receive(msg) {
    if (msg && msg.type) this._pendingMessages.push(msg);
  }
  // called by worklet wrapper / test harness once per 128-sample quantum
  processBlock(outChannels) {
    const n = this.blockLen;
    const outL = outChannels[0];
    const outR = outChannels.length > 1 ? outChannels[1] : outChannels[0];
    const L = this.outBufL;
    const R = this.outBufR;
    for (let i = 0; i < n; i++) {
      L[i] = 0;
      R[i] = 0;
      this.sendL[i] = 0;
      this.sendD[i] = 0;
    }
    if (this._pendingMessages.length) {
      for (const m of this._pendingMessages) this.handleMessage(m);
      this._pendingMessages.length = 0;
    }
    const blockEnd = this.frame + n;
    // 事件队列安全出队：非有限帧（历史坏消息）直接丢弃，不能让它卡住队首导致全局失声
    let guard = 0;
    while (this.events.length && guard++ < 8192) {
      const head = this.events[0];
      if (!Number.isFinite(head.frame)) {
        this.events.shift();
        continue;
      }
      if (head.frame > blockEnd) break;
      this.events.shift();
      this.applyEvent(head);
    }
    this.volume += (this.volumeTarget - this.volume) * 0.08;
    let anySolo = false;
    for (const tr of this.tracks) if (tr.solo) anySolo = true;
    for (const tr of this.tracks) {
      tr.smooth();
      const audible = !tr.mute && (anySolo ? tr.solo : true);
      tr.renderBlock(L, R, this.sendL, this.sendD, audible, n);
    }
    const reverb = this.reverb;
    const delay = this.delay;
    const vol = this.volume;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      reverb.run(this.sendL[i], this.sendL[i]);
      delay.run(this.sendD[i], this.sendD[i], 0.33);
      let l = L[i] + reverb.outL * 0.55 + delay.outL * 0.4;
      let r = R[i] + reverb.outR * 0.55 + delay.outR * 0.4;
      l *= vol;
      r *= vol;
      l = this.dcL.run(l);
      r = this.dcR.run(r);
      // 平滑软限幅：保留瞬态、压住过载峰值，不再出现硬削波
      l = tanhFast(l * 1.06) * 0.94;
      r = tanhFast(r * 1.06) * 0.94;
      if (!isFinite(l)) l = 0;
      if (!isFinite(r)) r = 0;
      L[i] = l;
      R[i] = r;
      const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      if (a > peak) peak = a;
    }
    this.renderClicks(L, R, n);
    for (let i = 0; i < n; i++) {
      outL[i] = L[i];
      if (outChannels.length > 1) outR[i] = R[i];
    }
    // 长反馈链路（混响/延迟/隔直）一旦吃到 NaN 会永久输出静音，
    // 每块检查一次状态，坏了就重建；界面上的播放状态不受影响，所以必须自动恢复
    if (!isFinite(this.volume)
      || !isFinite(this.dcL.y1) || !isFinite(this.dcR.y1)
      || !isFinite(this.reverb.outL) || !isFinite(this.delay.outL)) {
      this.resetMasterState();
    }
    this.frame += n;
    this.levelTimer += n;
    if (this.levelTimer >= 8192) {
      this.levelTimer = 0;
      const tracks = this.tracks.map((t) => Math.min(1, t.peak));
      this.postMessage({ type: 'levels', peak: Math.min(1, peak), tracks });
      this.masterPeak = 0;
    }
  }
  /** 重建总线上的长反馈状态（混响/延迟/隔直/音量平滑） */
  resetMasterState() {
    this.reverb.reset();
    this.delay.reset();
    this.dcL.reset();
    this.dcR.reset();
    this.volume = finite(this.volumeTarget, 1);
    this.recoveries++;
  }
  /**
   * 渲染异常后的自愈：清空事件与声部并重建全部延迟状态。
   * 调度器每 140ms 会重新排程，因此清空事件不会让播放永久中断。
   */
  recover() {
    this.events.length = 0;
    this.clicks.length = 0;
    for (const tr of this.tracks) {
      tr.voices.length = 0;
      tr.audioVoices.length = 0;
      tr.lpL = 0;
      tr.lpR = 0;
      tr.bend = 0;
      tr.bendTarget = 0;
      tr.appliedBend = 0;
      tr.pressure = 0;
      tr.pressureTarget = 0;
      tr.chorusIdx = 0;
      tr.chorusPhase = 0;
      tr.chorusBufL.fill(0);
      tr.chorusBufR.fill(0);
      tr.p = defaultParams(tr.type);
      tr.target = Object.assign({}, tr.p);
    }
    this.resetMasterState();
  }
  renderClicks(outL, outR, n) {
    if (!this.clicks.length) return;
    for (let i = 0; i < n; i++) {
      for (const c of this.clicks) {
        if (c.remaining > 0) {
          this.clickPhase += 900 / this.sr;
          if (this.clickPhase >= 1) this.clickPhase -= 1;
          const s = Math.sin(TWO_PI * this.clickPhase) * c.amp;
          outL[i] += s;
          outR[i] += s;
          c.remaining--;
        }
      }
    }
    this.clicks = this.clicks.filter((c) => c.remaining > 0);
  }
  /** 时间戳换算成帧；NaN/缺失时退回当前块，避免坏事件卡住整个事件队列 */
  frameOf(when) {
    const secs = finite(when, null);
    if (secs === null) return this.frame;
    return Math.round(secs * this.sr);
  }
  handleMessage(m) {
    switch (m.type) {
      case 'note': {
        if (!Number.isFinite(m.pitch)) break;
        const frame = this.frameOf(m.when);
        this.events.push({
          frame,
          kind: 'note',
          track: m.track,
          pitch: m.pitch,
          velocity: finite(m.velocity, 0.7),
          id: m.id,
          art: m.art,
          durFrames: Math.max(0, Math.round(finite(m.dur, 0) * this.sr)),
          seed: ++this.voiceSeed,
          src: m.src || 'transport',
          gen: m.gen,
        });
        this.sortEvents();
        break;
      }
      case 'noteOff': {
        const frame = this.frameOf(m.when);
        this.events.push({ frame, kind: 'off', track: m.track, id: m.id, src: m.src || 'live', gen: m.gen });
        this.sortEvents();
        break;
      }
      case 'allNotesOff':
        for (const tr of this.tracks) tr.allNotesOff();
        break;
      case 'bend': {
        const tr = this.tracks[m.track];
        if (tr) tr.setBend(finite(m.value, 0));
        break;
      }
      case 'pressure': {
        const tr = this.tracks[m.track];
        if (tr) tr.setPressure(finite(m.value, 0));
        break;
      }
      case 'asset': {
        if (m.assetId && Array.isArray(m.channels) && m.channels.length) {
          this.assets.set(m.assetId, {
            sampleRate: Math.max(1, finite(m.sampleRate, this.sr)),
            channels: m.channels,
          });
        }
        break;
      }
      case 'sbank': {
        // 采样音源库：音频线程只存 Int16 数据，渲染时再换算成浮点
        if (m.bankId && Array.isArray(m.samples) && m.samples.length) {
          const rate = Math.max(1, finite(m.sampleRate, this.sr));
          this.banks.set(m.bankId, {
            kind: m.kind === 'drums' ? 'drums' : 'pitched',
            sampleRate: rate,
            samples: m.samples
              .filter((s) => s && s.data && Number.isFinite(s.pitch))
              .map((s) => ({
                pitch: finite(s.pitch, 60),
                velMin: clamp(finite(s.velMin, 0), 0, 1),
                velMax: clamp(finite(s.velMax, 1), 0, 1),
                sampleRate: rate,
                data: s.data,
                loopStart: Math.max(0, finite(s.loopStart, 0)) * rate,
                loopEnd: Math.max(0, finite(s.loopEnd, 0)) * rate,
              })),
          });
        }
        break;
      }
      case 'audio': {
        const frame = this.frameOf(m.when);
        this.events.push({
          frame,
          kind: 'audio',
          track: m.track,
          assetId: m.assetId,
          offsetSec: Math.max(0, finite(m.offsetSec, 0)),
          durFrames: Math.max(0, Math.round(finite(m.dur, 0) * this.sr)),
          gain: finite(m.gain, 1),
          id: m.id,
          src: m.src || 'transport',
          gen: m.gen,
        });
        this.sortEvents();
        break;
      }
      case 'panic':
        for (const tr of this.tracks) {
          tr.voices.length = 0;
          tr.audioVoices.length = 0;
          tr.bend = tr.bendTarget = tr.appliedBend = 0;
          tr.pressure = tr.pressureTarget = 0;
        }
        this.events.length = 0;
        this.clicks.length = 0;
        break;
      /**
       * 取消某个来源的代际事件：新代际启用后，旧代际已排队的事件全部作废。
       * 例如停止运输只清 transport/click，不影响实时键盘与预设试听。
       */
      case 'resetSource': {
        const src = m.src;
        const gen = m.gen;
        this.events = this.events.filter((ev) => !(ev.src === src && (gen === undefined || ev.gen !== gen)));
        if (src === 'click') {
          this.clicks.length = 0;
        } else {
          for (const tr of this.tracks) {
            tr.releaseSource(src, gen);
            tr.releaseAudioSource(src, gen);
          }
        }
        break;
      }
      case 'track': {
        if (m.when !== undefined && m.when !== null) {
          this.events.push({
            frame: Math.max(this.frame, this.frameOf(m.when)),
            kind: 'track',
            m,
            src: m.src || 'automation',
            gen: m.gen,
          });
          this.sortEvents();
          break;
        }
        this.applyTrackMessage(m);
        break;
      }
      case 'master':
        if (m.volume !== undefined) this.volumeTarget = clamp(finite(m.volume, this.volumeTarget), 0, 1.5);
        break;
      case 'metronome': {
        const frame = this.frameOf(m.when);
        this.events.push({
          frame,
          kind: 'click',
          accent: !!m.accent,
          src: m.src || 'click',
          gen: m.gen,
        });
        this.sortEvents();
        break;
      }
      default:
        break;
    }
  }
  applyTrackMessage(m) {
    const tr = this.tracks[m.track];
    if (!tr) return;
    if (m.instrumentType && m.instrumentType !== tr.type) {
      tr.setType(m.instrumentType);
      tr.p = Object.assign(defaultParams(m.instrumentType), sanitizeParams(m.params) || {});
      tr.target = Object.assign({}, tr.p);
    } else if (m.params) {
      tr.setParams(m.params);
    }
    if (m.sampleBank !== undefined) {
      tr.sampleBank = typeof m.sampleBank === 'string' && m.sampleBank ? m.sampleBank : null;
    }
    if (m.volume !== undefined) tr.volumeTarget = clamp(finite(m.volume, tr.volumeTarget), 0, 1);
    if (m.pan !== undefined) tr.panTarget = clamp(finite(m.pan, tr.panTarget), -1, 1);
    if (m.mute !== undefined) tr.mute = !!m.mute;
    if (m.solo !== undefined) tr.solo = !!m.solo;
    if (m.sendReverb !== undefined) tr.sendRevTarget = clamp(finite(m.sendReverb, tr.sendRevTarget), 0, 1);
    if (m.sendDelay !== undefined) tr.sendDelayTarget = clamp(finite(m.sendDelay, tr.sendDelayTarget), 0, 1);
    if (m.tone !== undefined) tr.toneLP = clamp(finite(m.tone, tr.toneLP), 0.1, 1);
    if (m.drive !== undefined) tr.drive = clamp(finite(m.drive, tr.drive), 0, 1);
    if (m.chorus !== undefined) tr.chorus = clamp(finite(m.chorus, tr.chorus), 0, 1);
  }
  sortEvents() {
    if (this.events.length > 1) this.events.sort((a, b) => a.frame - b.frame);
    // 极端情况下（长时间不同步）队列不应无限增长，只保留最近的排程
    if (this.events.length > 8192) this.events.splice(0, this.events.length - 8192);
  }
  applyEvent(ev) {
    if (ev.kind === 'note') {
      const tr = this.tracks[ev.track];
      if (tr) tr.noteOn(ev.pitch, ev.velocity, ev.id, ev.art, ev.durFrames, ev.seed, ev.src, ev.gen);
    } else if (ev.kind === 'off') {
      const tr = this.tracks[ev.track];
      if (tr) tr.noteOff(ev.id);
    } else if (ev.kind === 'audio') {
      const tr = this.tracks[ev.track];
      const asset = this.assets.get(ev.assetId);
      if (tr && asset) tr.audioOn(asset, ev.offsetSec, ev.durFrames, ev.gain, ev.id, ev.src, ev.gen);
    } else if (ev.kind === 'click') {
      this.clicks.push({ remaining: Math.round(0.035 * this.sr), amp: ev.accent ? 0.1 : 0.055 });
      this.clickPhase = 0;
    } else if (ev.kind === 'track') {
      this.applyTrackMessage(ev.m);
    }
  }
}

// ----------------------------------------------------------------------------
// AudioWorklet wrapper
// ----------------------------------------------------------------------------
if (typeof registerProcessor === 'function') {
  class StudioWorklet extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.sp = new StudioProcessor({
        sampleRate: sampleRate,
        post: (msg) => this.port.postMessage(msg),
      });
      this.lastErrorFrame = -Infinity;
      this.port.onmessage = (e) => this.sp.receive(e.data);
    }
    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || out.length === 0) return true;
      try {
        this.sp.processBlock(out);
      } catch (err) {
        // AudioWorkletProcessor 抛异常会被 Chromium 直接停用，节点从此静默：
        // 界面仍显示正在播放却没有声音。这里自愈并上报，保证节点继续工作。
        for (let c = 0; c < out.length; c++) out[c].fill(0);
        this.sp.recover();
        const message = err && err.message ? err.message : String(err);
        if (this.sp.frame - this.lastErrorFrame > sampleRate) {
          this.lastErrorFrame = this.sp.frame;
          this.port.postMessage({ type: 'error', message });
        }
      }
      return true;
    }
  }
  registerProcessor('soundweave-studio', StudioWorklet);
}

export { StudioProcessor, defaultParams, TYPE_DEFAULTS, DRUM_MAP, mtof, MAX_TRACKS };
