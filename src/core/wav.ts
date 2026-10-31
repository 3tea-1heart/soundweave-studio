/** 浏览器端 16-bit PCM WAV 编码与解码 */

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = Math.max(1, channels.length);
  const frames = channels[0].length;
  const dataBytes = frames * numCh * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      if (!Number.isFinite(s)) s = 0;
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return buffer;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
  duration: number;
}

export function decodeWav(arrayBuffer: ArrayBuffer): DecodedWav {
  const view = new DataView(arrayBuffer);
  const readStr = (off: number) => String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3),
  );
  if (readStr(0) !== 'RIFF' || readStr(8) !== 'WAVE') throw new Error('不是有效的 WAV 文件');
  let pos = 12;
  let fmt = 0;
  let numCh = 0;
  let sampleRate = 0;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= view.byteLength) {
    const id = readStr(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = view.getUint16(body, true);
      numCh = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE：真实格式在 SubFormat GUID 的前两字节
      if (fmt === 0xfffe && size >= 40) fmt = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, view.byteLength - body);
    }
    pos = body + size + (size & 1);
  }
  if (fmt !== 1 && fmt !== 3) throw new Error(`暂不支持 WAV 编码格式 ${fmt}`);
  if (!numCh || !sampleRate || dataOff < 0) throw new Error('WAV 文件缺少音频数据');
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32 && bits !== 64) {
    throw new Error(`暂不支持 ${bits} 位 WAV`);
  }
  if (bits === 64 && fmt !== 3) throw new Error('暂不支持 64 位整数 WAV');
  const frameSize = numCh * (bits / 8);
  const frames = Math.floor(dataLen / frameSize);
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  const step = bits / 8;
  let off = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      if (fmt === 3 && bits === 32) {
        channels[c][i] = view.getFloat32(off, true);
      } else if (fmt === 3 && bits === 64) {
        channels[c][i] = view.getFloat64(off, true);
      } else if (bits === 16) {
        channels[c][i] = view.getInt16(off, true) / 32768;
      } else if (bits === 8) {
        channels[c][i] = (view.getUint8(off) - 128) / 128;
      } else if (bits === 24) {
        const v = view.getUint8(off) | (view.getUint8(off + 1) << 8) | (view.getUint8(off + 2) << 16);
        channels[c][i] = ((v << 8) >> 8) / 8388608;
      } else {
        channels[c][i] = view.getInt32(off, true) / 2147483648;
      }
      off += step;
    }
  }
  return { sampleRate, channels, duration: frames / sampleRate };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'soundweave';
}
