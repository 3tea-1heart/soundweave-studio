import type { MusicBlock, Note, InstrumentType, Articulation } from './types';
import { uid } from './project';
import { loadUserBlocks } from './user-blocks';

const n = (pitch: number, start: number, length: number, velocity = 0.7, articulation: Articulation = 'normal'): Note => ({
  id: uid('n'),
  pitch,
  start,
  length,
  velocity,
  articulation,
});

const CHORDS: Record<string, number[]> = {
  C: [60, 64, 67],
  C7: [60, 64, 67, 70],
  Cmaj7: [60, 64, 67, 71],
  C9: [60, 64, 67, 70, 74],
  Am: [57, 60, 64],
  Am7: [57, 60, 64, 67],
  Am9: [57, 60, 64, 67, 71],
  'Am7b5': [57, 60, 63, 67],
  F: [53, 57, 60],
  Fmaj7: [53, 57, 60, 64],
  Fmaj9: [53, 57, 60, 64, 67],
  G: [55, 59, 62],
  G7: [55, 59, 62, 65],
  G9: [55, 59, 62, 65, 69],
  Dm: [50, 53, 57],
  Dm7: [50, 53, 57, 60],
  D: [50, 54, 57],
  D7: [50, 54, 57, 60],
  Em: [52, 55, 59],
  Em7: [52, 55, 59, 62],
  E: [52, 56, 59],
  Gm: [55, 58, 62],
  Gm7: [55, 58, 62, 65],
  'C/G': [55, 60, 64, 67],
  'Am/E': [52, 57, 60, 64],
  'F/C': [48, 53, 57, 60],
  'G/D': [50, 55, 59, 62],
};

function chordNotes(chord: string, beat: number, len: number, vel = 0.7): Note[] {
  const v = CHORDS[chord] || CHORDS.C;
  return v.map((p) => n(p, beat, len, vel));
}

function chords(prog: string[], barsPerChord: number, vel = 0.7): Note[] {
  const out: Note[] = [];
  prog.forEach((c, i) => out.push(...chordNotes(c, i * barsPerChord * 4, barsPerChord * 4 - 0.02, vel)));
  return out;
}

function stabs(chord: string, beat: number, count: number, len = 0.28, vel = 0.72, step = 0.5): Note[] {
  const out: Note[] = [];
  for (let i = 0; i < count; i++) out.push(...chordNotes(chord, beat + i * step + 0.25, len, vel));
  return out;
}

function arp(chord: string, beat: number, bars: number, vel = 0.68): Note[] {
  const v = CHORDS[chord] || CHORDS.C;
  const seq = [...v, ...v.slice().reverse()];
  const out: Note[] = [];
  const totalSteps = bars * 8;
  for (let i = 0; i < totalSteps; i++) {
    out.push(n(seq[i % seq.length], beat + i * 0.5, 0.42, vel));
  }
  return out;
}

function drums(bars: number, hits: Array<[number, number, number?]>, swing = 0): Note[] {
  return hits.map(([pitch, step, vel]) => {
    const beat = step * 0.25 + (step % 2 === 1 ? swing : 0);
    return n(pitch, beat, 0.18, vel ?? 0.8);
  });
}

const block = (
  id: string,
  name: string,
  category: MusicBlock['category'],
  bars: number,
  style: string,
  tempoRange: [number, number],
  recommendedType: InstrumentType,
  tags: string[],
  notes: Note[],
  key = 'C',
): MusicBlock => ({
  id,
  name,
  category,
  bars,
  beatCount: bars * 4,
  key,
  style,
  tempoRange,
  recommendedType,
  tags,
  notes,
});

const B: MusicBlock[] = [];

// ============================ 和弦 12 ============================
B.push(block('ch-pop-warm', '温暖流行进行', 'chords', 4, '流行', [70, 120], 'ep', ['C-Am-F-G', '持续和弦'], chords(['C', 'Am', 'F', 'G'], 1)));
B.push(block('ch-pop-love', '情歌进行', 'chords', 4, '流行抒情', [60, 100], 'piano', ['Am-F-C-G', '抒情'], chords(['Am', 'F', 'C', 'G'], 1, 0.65)));
B.push(block('ch-seventh', '七和弦循环', 'chords', 4, '爵士流行', [70, 130], 'ep', ['Cmaj7', 'Am7', 'Dm7', 'G7'], chords(['Cmaj7', 'Am7', 'Dm7', 'G7'], 1, 0.62)));
B.push(block('ch-ninth', '九和弦色彩', 'chords', 4, 'Neo Soul', [65, 110], 'ep', ['9和弦', '色彩'], chords(['Fmaj9', 'G9', 'Em7', 'Am9'], 1, 0.58)));
B.push(block('ch-invert', '转位低音进行', 'chords', 4, '流行', [75, 125], 'piano', ['转位', 'C/G'], chords(['C/G', 'Am/E', 'F/C', 'G/D'], 1, 0.68)));
B.push(block('ch-stabs', '切分和弦伴奏', 'chords', 4, 'Funk Pop', [80, 132], 'ep', ['切分', '伴奏'], [...stabs('C', 0, 4), ...stabs('Am', 4, 4), ...stabs('F', 8, 4), ...stabs('G', 12, 4)]));
B.push(block('ch-sustain', '持续和弦铺底', 'chords', 4, '氛围', [55, 90], 'synth', ['长音', '氛围'], chords(['Cmaj7', 'Cmaj7', 'Cmaj7', 'Cmaj7'], 1, 0.5)));
B.push(block('ch-minor', '小调进行', 'chords', 4, '小调', [65, 115], 'piano', ['Am-G-F-E', '小调'], chords(['Am', 'G', 'F', 'E'], 1, 0.66)));
B.push(block('ch-jazz', 'ii-V-I 爵士', 'chords', 4, '爵士', [80, 140], 'ep', ['Dm7', 'G7', 'Cmaj7'], [...chordNotes('Dm7', 0, 3.98, 0.6), ...chordNotes('G7', 4, 3.98, 0.62), ...chordNotes('Cmaj7', 8, 7.96, 0.66)]));
B.push(block('ch-arp', '琶音式伴奏', 'chords', 4, '流行', [75, 130], 'guitar', ['琶音', '分解和弦'], [...arp('C', 0, 1), ...arp('Am', 4, 1), ...arp('F', 8, 1), ...arp('G', 12, 1)]));
B.push(block('ch-halfdim', '半减七色彩', 'chords', 4, '爵士小调', [70, 120], 'piano', ['half-diminished', 'Am7b5'], chords(['Am7b5', 'D7', 'Gm7', 'C'], 1, 0.58)));
B.push(block('ch-1554', '1-5-6-4 切分', 'chords', 4, '流行', [80, 128], 'ep', ['C-G-Am-F', '切分'], [...stabs('C', 0, 4), ...stabs('G', 4, 4), ...stabs('Am', 8, 4), ...stabs('F', 12, 4, 0.3, 0.7, 1)]));

// ============================ 旋律 10 ============================
const M = (id: string, name: string, bars: number, style: string, tempoRange: [number, number], type: InstrumentType, tags: string[], notes: Note[]): MusicBlock => {
  const b = block(id, name, 'melody', bars, style, tempoRange, type, tags, notes);
  B.push(b);
  return b;
};

M('mel-arp-c', 'C 大三琶音', 2, '琶音', [70, 130], 'synth', ['琶音', 'C'], [
  n(72, 0, 0.45), n(76, 0.5, 0.45), n(79, 1, 0.45), n(84, 1.5, 0.45),
  n(79, 2, 0.45), n(76, 2.5, 0.45), n(72, 3, 0.9), n(67, 4, 0.45),
  n(72, 4.5, 0.45), n(76, 5, 0.45), n(79, 5.5, 0.45), n(84, 6, 0.45),
  n(79, 6.5, 0.45), n(76, 7, 0.45), n(72, 7.5, 0.45),
]);
M('mel-arp-am', 'A 小调琶音', 2, '琶音', [70, 120], 'synth', ['琶音', 'Am'], [
  n(69, 0, 0.45), n(72, 0.5, 0.45), n(76, 1, 0.45), n(81, 1.5, 0.45),
  n(76, 2, 0.45), n(72, 2.5, 0.45), n(69, 3, 0.9), n(64, 4, 0.45),
  n(69, 4.5, 0.45), n(72, 5, 0.45), n(76, 5.5, 0.45), n(81, 6, 0.45),
  n(76, 6.5, 0.45), n(72, 7.25, 0.75),
]);
M('mel-up', '上行动机', 2, '动机', [75, 130], 'synth', ['动机', '上行'], [
  n(67, 0, 0.5, 0.6), n(69, 0.5, 0.5, 0.65), n(72, 1, 0.5, 0.7), n(74, 1.5, 0.5, 0.72),
  n(76, 2, 1.5, 0.78), n(72, 4, 0.5, 0.62), n(74, 4.5, 0.5, 0.66), n(76, 5, 0.5, 0.7),
  n(79, 5.5, 0.5, 0.75), n(84, 6, 1.9, 0.82),
]);
M('mel-down', '下行动机', 2, '动机', [75, 130], 'synth', ['动机', '下行'], [
  n(84, 0, 0.6, 0.8), n(81, 0.5, 0.5, 0.74), n(79, 1, 0.9, 0.7), n(76, 2, 0.5, 0.64),
  n(74, 2.5, 0.5, 0.6), n(72, 3, 0.95, 0.58), n(76, 4, 0.5, 0.7), n(72, 4.5, 0.5, 0.66),
  n(69, 5, 1.5, 0.62), n(67, 7, 0.9, 0.55),
]);
M('mel-penta', '五声音阶乐句', 2, '五声', [70, 120], 'synth', ['五声', '东方'], [
  n(72, 0, 0.45, 0.6), n(74, 0.5, 0.45, 0.64), n(76, 1, 0.45, 0.7), n(79, 1.5, 0.9, 0.74),
  n(76, 2.5, 0.45, 0.68), n(74, 3, 0.9, 0.62), n(72, 4, 0.45, 0.6), n(69, 4.5, 0.45, 0.62),
  n(72, 5, 0.45, 0.68), n(76, 5.5, 0.45, 0.72), n(79, 6, 0.45, 0.76), n(84, 6.5, 1.4, 0.8),
]);
M('mel-sync', '切分旋律 riff', 2, 'Funk', [85, 135], 'synth', ['切分', 'riff'], [
  n(64, 0, 0.3, 0.7), n(67, 0.5, 0.3, 0.72), n(72, 1.25, 0.3, 0.78), n(76, 1.75, 0.5, 0.75),
  n(74, 2.5, 0.3, 0.68), n(72, 3, 0.9, 0.72), n(67, 4, 0.3, 0.7), n(71, 4.5, 0.3, 0.74),
  n(76, 5.25, 0.3, 0.8), n(79, 5.75, 0.5, 0.76), n(76, 6.5, 0.3, 0.7), n(74, 7, 0.9, 0.68),
]);
M('mel-qa', '问答乐句', 4, '抒情', [65, 110], 'ep', ['问答', '抒情'], [
  n(76, 0, 1, 0.68), n(79, 1.5, 0.5, 0.7), n(81, 2, 0.5, 0.72), n(79, 3, 1, 0.66),
  n(76, 4.5, 1, 0.7), n(74, 6, 0.5, 0.62), n(72, 7, 1, 0.64),
  n(69, 8, 1, 0.6), n(72, 9.5, 0.5, 0.66), n(74, 10, 0.5, 0.68), n(76, 11, 1, 0.7),
  n(79, 12.5, 0.5, 0.74), n(76, 13, 0.5, 0.7), n(72, 14, 1.8, 0.62),
]);
M('mel-ornament', '装饰音旋律', 2, '古典流行', [70, 120], 'piano', ['装饰音', '细节'], [
  n(72, 0, 1, 0.64), n(74, 1.05, 0.18, 0.7), n(76, 1.5, 1, 0.72), n(74, 2.75, 0.18, 0.62),
  n(72, 3, 1, 0.6), n(76, 4, 0.5, 0.7), n(77, 4.55, 0.18, 0.72), n(79, 5, 0.5, 0.74),
  n(76, 5.75, 0.18, 0.66), n(79, 6, 1.9, 0.78),
]);
M('mel-repeat', '重复 ostinato', 4, '电子', [90, 140], 'synth', ['ostinato', '循环'], [
  n(76, 0, 0.35, 0.7), n(79, 0.5, 0.35, 0.72), n(76, 1.25, 0.35, 0.68), n(72, 1.75, 0.35, 0.64),
  n(76, 2, 0.35, 0.7), n(74, 2.5, 0.35, 0.66), n(76, 3, 0.85, 0.72),
  n(76, 4, 0.35, 0.7), n(81, 4.5, 0.35, 0.74), n(79, 5.25, 0.35, 0.7), n(76, 5.75, 0.35, 0.66),
  n(74, 6, 0.35, 0.68), n(72, 6.5, 0.35, 0.64), n(74, 7, 0.85, 0.7),
  n(76, 8, 0.35, 0.72), n(79, 8.5, 0.35, 0.74), n(81, 9.25, 0.35, 0.76), n(84, 9.75, 0.35, 0.78),
  n(81, 10, 0.35, 0.72), n(79, 10.5, 0.35, 0.7), n(76, 11, 0.85, 0.68),
  n(74, 12, 0.35, 0.66), n(76, 12.5, 0.35, 0.7), n(79, 13.25, 0.35, 0.72), n(76, 13.75, 0.35, 0.68),
  n(74, 14, 0.35, 0.64), n(72, 14.5, 0.35, 0.62), n(69, 15, 0.85, 0.6),
]);
M('mel-octave', '八度跳进主题', 2, '电子', [85, 135], 'synth', ['跳进', '主题'], [
  n(72, 0, 0.5, 0.72), n(84, 0.5, 0.75, 0.78), n(76, 1.5, 0.5, 0.7), n(84, 2, 0.5, 0.74),
  n(72, 2.5, 0.5, 0.68), n(76, 3, 0.9, 0.7), n(79, 4, 0.5, 0.74), n(88, 4.5, 0.75, 0.8),
  n(79, 5.5, 0.5, 0.7), n(84, 6, 0.5, 0.74), n(76, 6.5, 0.5, 0.68), n(79, 7, 0.9, 0.72),
]);

// ============================ 贝斯 8 ============================
const Ba = (id: string, name: string, bars: number, style: string, tempoRange: [number, number], tags: string[], notes: Note[], type: InstrumentType = 'bass'): MusicBlock => {
  const b = block(id, name, 'bass', bars, style, tempoRange, type, tags, notes);
  B.push(b);
  return b;
};

Ba('bass-root', '根音四分节奏', 4, '基础', [70, 130], ['根音', '四分'], [
  n(48, 0, 1, 0.75), n(48, 1, 1, 0.7), n(48, 2, 1, 0.7), n(48, 3, 1, 0.72),
  n(45, 4, 1, 0.75), n(45, 5, 1, 0.7), n(45, 6, 1, 0.7), n(45, 7, 1, 0.72),
  n(41, 8, 1, 0.75), n(41, 9, 1, 0.7), n(41, 10, 1, 0.7), n(41, 11, 1, 0.72),
  n(43, 12, 1, 0.75), n(43, 13, 1, 0.7), n(43, 14, 1, 0.7), n(43, 15, 1, 0.72),
]);
Ba('bass-fifth', '根音与五度', 4, '流行', [75, 130], ['五度', '八分'], [
  n(48, 0, 0.9, 0.75), n(55, 1, 0.4, 0.6), n(48, 1.5, 0.9, 0.7), n(55, 2.5, 0.4, 0.6),
  n(48, 3, 0.9, 0.72), n(45, 4, 0.9, 0.75), n(52, 5, 0.4, 0.6), n(45, 5.5, 0.9, 0.7),
  n(52, 6.5, 0.4, 0.6), n(45, 7, 0.9, 0.72),
  n(41, 8, 0.9, 0.75), n(48, 9, 0.4, 0.6), n(41, 9.5, 0.9, 0.7), n(48, 10.5, 0.4, 0.6),
  n(41, 11, 0.9, 0.72), n(43, 12, 0.9, 0.75), n(50, 13, 0.4, 0.6), n(43, 13.5, 0.9, 0.7),
  n(50, 14.5, 0.4, 0.6), n(43, 15, 0.9, 0.72),
]);
Ba('bass-octave', '八度弹跳', 2, 'Funk', [85, 135], ['八度', '律动'], [
  n(48, 0, 0.4, 0.78), n(60, 0.5, 0.4, 0.7), n(48, 1, 0.4, 0.76), n(60, 1.5, 0.4, 0.7),
  n(48, 2, 0.4, 0.76), n(55, 2.5, 0.4, 0.68), n(48, 3, 0.9, 0.74),
  n(45, 4, 0.4, 0.78), n(57, 4.5, 0.4, 0.7), n(45, 5, 0.4, 0.76), n(57, 5.5, 0.4, 0.7),
  n(45, 6, 0.4, 0.76), n(52, 6.5, 0.4, 0.68), n(45, 7, 0.9, 0.74),
]);
Ba('bass-sync', '切分贝斯', 2, 'Pop', [80, 130], ['切分', '推动'], [
  n(48, 0, 0.6, 0.8), n(48, 1.25, 0.4, 0.72), n(48, 2, 0.3, 0.7), n(55, 2.75, 0.5, 0.74),
  n(48, 3.5, 0.4, 0.7), n(45, 4, 0.6, 0.78), n(45, 5.25, 0.4, 0.7), n(45, 6, 0.3, 0.68),
  n(52, 6.75, 0.5, 0.72), n(45, 7.5, 0.4, 0.68),
]);
Ba('bass-walk', '行走贝斯', 4, '爵士', [80, 140], ['走句', '爵士'], [
  n(48, 0, 0.95, 0.7), n(52, 1, 0.95, 0.68), n(53, 2, 0.95, 0.68), n(55, 3, 0.95, 0.7),
  n(57, 4, 0.95, 0.71), n(55, 5, 0.95, 0.68), n(53, 6, 0.95, 0.66), n(52, 7, 0.95, 0.68),
  n(48, 8, 0.95, 0.7), n(52, 9, 0.95, 0.68), n(53, 10, 0.95, 0.68), n(55, 11, 0.95, 0.7),
  n(57, 12, 0.95, 0.71), n(55, 13, 0.95, 0.68), n(52, 14, 0.95, 0.66), n(48, 15, 0.95, 0.7),
]);
Ba('bass-pedal', 'C 踏板低音', 4, '氛围', [60, 110], ['踏板', '持续'], [
  n(48, 0, 3.9, 0.72), n(48, 4, 3.9, 0.72), n(48, 8, 3.9, 0.72), n(48, 12, 3.9, 0.74),
]);
Ba('bass-funk', 'Funk 十六分贝斯', 2, 'Funk', [85, 140], ['十六分', 'Funk'], [
  n(48, 0, 0.22, 0.8), n(48, 0.25, 0.22, 0.6), n(55, 0.5, 0.22, 0.72), n(52, 0.75, 0.22, 0.58),
  n(48, 1, 0.22, 0.76), n(48, 1.25, 0.22, 0.6), n(55, 1.5, 0.22, 0.7), n(48, 1.75, 0.22, 0.62),
  n(48, 2, 0.22, 0.78), n(48, 2.25, 0.22, 0.6), n(55, 2.5, 0.22, 0.72), n(52, 2.75, 0.22, 0.58),
  n(48, 3, 0.22, 0.74), n(55, 3.25, 0.22, 0.66), n(52, 3.5, 0.22, 0.6), n(48, 3.75, 0.22, 0.58),
  n(45, 4, 0.22, 0.8), n(45, 4.25, 0.22, 0.6), n(52, 4.5, 0.22, 0.72), n(49, 4.75, 0.22, 0.58),
  n(45, 5, 0.22, 0.76), n(45, 5.25, 0.22, 0.6), n(52, 5.5, 0.22, 0.7), n(45, 5.75, 0.22, 0.62),
  n(45, 6, 0.22, 0.78), n(45, 6.25, 0.22, 0.6), n(52, 6.5, 0.22, 0.72), n(49, 6.75, 0.22, 0.58),
  n(45, 7, 0.22, 0.74), n(52, 7.25, 0.22, 0.66), n(49, 7.5, 0.22, 0.6), n(45, 7.75, 0.22, 0.58),
]);
Ba('bass-half', '半拍长音贝斯', 2, 'Downtempo', [60, 100], ['长音', '半拍'], [
  n(48, 0, 1.9, 0.76), n(48, 2, 1.4, 0.7), n(45, 4, 1.9, 0.74), n(45, 6, 1.4, 0.68),
]);

// ============================ 鼓 12 ============================
const Dr = (id: string, name: string, style: string, tempoRange: [number, number], tags: string[], hits: Array<[number, number, number?]>, bars = 2, swing = 0): MusicBlock => {
  const b = block(id, name, 'drums', bars, style, tempoRange, 'drum', tags, drums(bars, hits, swing));
  B.push(b);
  return b;
};

const fourFloor: Array<[number, number, number]> = [];
for (let b = 0; b < 2; b++) {
  const o = b * 16;
  for (const s of [0, 4, 8, 12]) fourFloor.push([36, o + s, 0.85]);
  for (const s of [2, 6, 10, 14]) fourFloor.push([42, o + s, 0.5]);
}
Dr('dr-house', '四拍舞曲', 'House', [110, 140], ['四拍', '电子'], fourFloor);
Dr('dr-pop', '基础流行', 'Pop', [80, 130], ['流行', '基础'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.9], [36, o + 8, 0.8], [38, o + 4, 0.8], [38, o + 12, 0.75]);
    for (const s of [2, 6, 10, 14]) h.push([42, o + s, 0.5]);
  }
  return h;
})());
Dr('dr-half', '半拍律动', 'Downtempo', [60, 100], ['半拍', '慢速'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.9], [36, o + 6, 0.7], [38, o + 8, 0.85], [36, o + 14, 0.7]);
    for (const s of [4, 12]) h.push([42, o + s, 0.5]);
    h.push([49, o + 9, 0.6]);
  }
  return h;
})());
Dr('dr-lofi', 'Lo-fi 稀疏', 'Lo-fi', [65, 105], ['Lo-fi', '稀疏'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.75], [36, o + 7, 0.65], [38, o + 5, 0.7], [38, o + 13, 0.68]);
    for (const s of [3, 9, 11, 15]) h.push([50, o + s, 0.4]);
    h.push([42, o + 2, 0.35]);
  }
  return h;
})());
Dr('dr-break', '碎拍 Breakbeat', 'Breakbeat', [100, 140], ['碎拍', '律动'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.9], [36, o + 3, 0.75], [36, o + 10, 0.8], [38, o + 6, 0.82], [38, o + 13, 0.8]);
    for (const s of [1, 5, 9, 14]) h.push([42, o + s, 0.5]);
    h.push([44, o + 15, 0.55]);
  }
  return h;
})());
Dr('dr-shuffle', '摇摆律动', 'Shuffle', [70, 110], ['swing', '摇摆'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.85], [36, o + 8, 0.8], [38, o + 4, 0.78], [38, o + 12, 0.76]);
    for (const s of [0, 4, 8, 12]) h.push([42, o + s, 0.45]);
    h.push([42, o + 6, 0.4], [42, o + 14, 0.4]);
  }
  return h;
})(), 2, 0.12);
Dr('dr-funk', 'Funk 节奏', 'Funk', [90, 130], ['Funk', '切分'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.9], [36, o + 5, 0.7], [36, o + 9, 0.75], [36, o + 13, 0.7]);
    h.push([38, o + 3, 0.8], [38, o + 7, 0.75], [38, o + 11, 0.78], [38, o + 15, 0.72]);
    for (const s of [1, 4, 6, 10, 14]) h.push([42, o + s, 0.45]);
    if (b === 1) h.push([49, o + 12, 0.65]);
  }
  return h;
})());
Dr('dr-minimal', '极简节拍', 'Minimal', [90, 130], ['极简', '点击'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.85], [36, o + 8, 0.7]);
    h.push([42, o + 4, 0.4], [42, o + 12, 0.4]);
  }
  return h;
})());
Dr('dr-trap', '密集踩镲', 'Trap', [70, 110], ['trap', '踩镲'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.9], [36, o + 7, 0.75], [38, o + 10, 0.8]);
    for (let s = 0; s < 16; s += 2) h.push([42, o + s, s % 4 === 0 ? 0.55 : 0.4]);
    if (b === 1) h.push([38, o + 14, 0.7]);
  }
  return h;
})(), 2, 0.08);
Dr('dr-openhat', '开镲 House', 'House', [115, 140], ['开镲', '律动'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    for (const s of [0, 4, 8, 12]) h.push([36, o + s, 0.85]);
    h.push([42, o + 2, 0.5], [42, o + 6, 0.5], [42, o + 10, 0.5]);
    h.push([44, o + 14, 0.55]);
    h.push([49, o + 13, 0.55]);
  }
  return h;
})());
Dr('dr-experimental', '实验节奏', 'Experimental', [70, 120], ['实验', '不规则'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 16;
    h.push([36, o, 0.8], [36, o + 3, 0.65], [36, o + 11, 0.75]);
    h.push([38, o + 6, 0.7], [38, o + 9, 0.6]);
    h.push([55, o + 2, 0.5], [55, o + 13, 0.55]);
    h.push([51, o + 15, 0.5]);
    h.push([42, o + 4, 0.35], [42, o + 14, 0.35]);
  }
  return h;
})());
Dr('dr-crash', '镲片与通鼓开场', 'Intro', [80, 130], ['开场', '通鼓'], (() => {
  const h: Array<[number, number, number]> = [[51, 0, 0.8]];
  for (let s = 4; s < 16; s += 2) h.push([45, s, 0.5 + (s / 16) * 0.3]);
  for (const s of [0, 4, 8, 12]) h.push([36, s + 16, 0.8]);
  for (const s of [2, 6, 10, 14]) h.push([42, s + 16, 0.45]);
  return h;
})());

// ============================ 填充 / 过渡 6 ============================
const F = (id: string, name: string, bars: number, style: string, tempoRange: [number, number], type: InstrumentType, tags: string[], notes: Note[]): MusicBlock => {
  const b = block(id, name, 'fill', bars, style, tempoRange, type, tags, notes);
  B.push(b);
  return b;
};

F('fill-snare', '军鼓加速滚奏', 1, '鼓花', [80, 140], 'drum', ['军鼓', '滚奏'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let i = 0; i < 8; i++) h.push([38, i * 2, 0.55 + i * 0.04]);
  for (let i = 0; i < 8; i++) h.push([38, 8 + i, 0.7 + i * 0.03]);
  return drums(1, h);
})());
F('fill-tom', '通鼓下行填充', 1, '鼓花', [75, 130], 'drum', ['通鼓', '下行'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let i = 0; i < 6; i++) h.push([45, 4 + i * 2, 0.7]);
  h.push([36, 12, 0.9], [38, 13, 0.8], [36, 14, 0.85], [51, 15, 0.7]);
  return drums(1, h);
})());
F('fill-crash-stop', '镲片停顿', 1, '段落连接', [80, 130], 'drum', ['停顿', '镲片'], (() => {
  const h: Array<[number, number, number]> = [[36, 0, 0.9], [38, 2, 0.8], [38, 3, 0.8]];
  h.push([51, 8, 0.9], [36, 12, 0.85]);
  return drums(1, h);
})());
F('fill-riser', '合成上升', 2, '过渡', [80, 140], 'synth', ['上升', '过渡'], (() => {
  const out: Note[] = [];
  for (let i = 0; i < 16; i++) out.push(n(48 + i * 1.5, i * 0.5, 0.45, 0.55 + (i / 16) * 0.35));
  return out;
})());
F('fill-drop', '鼓花接镲片', 1, '段落连接', [80, 140], 'drum', ['鼓花', '落点'], (() => {
  const h: Array<[number, number, number]> = [];
  for (let i = 0; i < 4; i++) h.push([38, i * 2, 0.6 + i * 0.05]);
  for (let i = 0; i < 4; i++) h.push([45, 8 + i, 0.65]);
  h.push([36, 12, 0.9], [51, 13, 0.85], [38, 15, 0.8]);
  return drums(1, h);
})());
F('fill-breath', '呼吸留白', 2, '过渡', [60, 110], 'synth', ['留白', '氛围'], [
  n(55, 0, 3.6, 0.45), n(60, 4, 3.6, 0.5), n(67, 7.5, 0.5, 0.55),
]);

export const BLOCKS: MusicBlock[] = B;

export const BLOCK_CATEGORIES: Array<{ id: MusicBlock['category']; label: string }> = [
  { id: 'chords', label: '和弦' },
  { id: 'melody', label: '旋律' },
  { id: 'bass', label: '贝斯' },
  { id: 'drums', label: '鼓' },
  { id: 'fill', label: '填充' },
];

/** 内置 + 用户保存的编曲块 */
export function allBlocks(): MusicBlock[] {
  return [...BLOCKS, ...loadUserBlocks()];
}

export function blockById(id: string): MusicBlock | undefined {
  return BLOCKS.find((b) => b.id === id) || loadUserBlocks().find((b) => b.id === id);
}

export function blocksByCategory(cat: MusicBlock['category']): MusicBlock[] {
  return allBlocks().filter((b) => b.category === cat);
}

export function cloneBlockNotes(b: MusicBlock, transpose = 0): Note[] {
  return b.notes.map((x) => ({
    id: uid('n'),
    pitch: x.pitch + transpose,
    start: x.start,
    length: x.length,
    velocity: x.velocity,
    articulation: x.articulation,
  }));
}
