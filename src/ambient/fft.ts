/**
 * 实值 FFT（基数-2 迭代 Cooley–Tukey，无外部依赖）。
 * 供参考音频分析使用；输入长度必须是 2 的幂，输出为复频谱（正频部分在 [0, n/2]）。
 */

const TWO_PI = Math.PI * 2;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 就地迭代 radix-2 FFT（re/im 为复数时域，长度必须是 2 的幂） */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TWO_PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const k = i + j;
        const m = i + j + half;
        const uRe = re[k];
        const uIm = im[k];
        const vRe = re[m] * wr - im[m] * wi;
        const vIm = re[m] * wi + im[m] * wr;
        re[k] = uRe + vRe;
        im[k] = uIm + vIm;
        re[m] = uRe - vRe;
        im[m] = uIm - vIm;
        const t = wr * wRe - wi * wIm;
        wi = wr * wIm + wi * wRe;
        wr = t;
      }
    }
  }
}

export interface Spectrum {
  /** 幅度谱（长度 n/2 + 1，包含 DC） */
  magnitude: Float64Array;
  /** FFT 大小 */
  fftSize: number;
}

/**
 * 对一段（已加窗/未加窗的）实信号做 FFT，返回幅度谱。
 * 自动补零到下一个 2 的幂。
 */
export function magnitudeSpectrum(signal: Float64Array | Float32Array, fftSize?: number): Spectrum {
  const n = nextPow2(signal.length);
  const size = fftSize && fftSize > signal.length ? Math.max(n, nextPow2(fftSize)) : n;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];
  fftInPlace(re, im);
  const mag = new Float64Array((size >> 1) + 1);
  for (let k = 0; k <= size >> 1; k++) {
    const r = re[k];
    const imv = im[k];
    mag[k] = Math.sqrt(r * r + imv * imv);
  }
  return { magnitude: mag, fftSize: size };
}

/** Hann 窗（就地写回） */
export function hannWindow(signal: Float32Array | Float64Array): void {
  const n = signal.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    signal[i] *= 0.5 - 0.5 * Math.cos((TWO_PI * i) / (n - 1));
  }
}