import { LETTER_NAMES, LETTER_BASE } from './notation';

/**
 * 音阶与和弦：按所选音阶（调性中心 + 音阶类型）生成自然三/七和弦，
 * 输出罗马级数 + 和弦符号，并可依据当前正在发声的音高实时给出最佳匹配。
 */

export interface ScaleDef {
  id: string;
  name: string;
  intervals: number[];
}

export const SCALES: ScaleDef[] = [
  { id: 'major', name: '大调', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: '自然小调', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'dorian', name: '多利亚', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: '弗里几亚', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: '利底亚', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: '混合利底亚', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'harmonic-minor', name: '和声小调', intervals: [0, 2, 3, 5, 7, 8, 11] },
];

export function scaleById(id: string): ScaleDef {
  return SCALES.find((s) => s.id === id) ?? SCALES[0];
}

export function scaleIds(): string[] {
  return SCALES.map((s) => s.id);
}

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 音级 → 音名（升号默认拼写） */
export function noteName(pc: number): string {
  return PC_NAMES[((pc % 12) + 12) % 12];
}

export interface Chord {
  /** 0-based 音阶级数 */
  degree: number;
  /** 罗马级数，如 I / ii / V7 / vii° */
  numeral: string;
  /** 和弦符号，如 Cmaj7 / Dm7 / G7 */
  symbol: string;
  /** 根音音级（pitch class） */
  root: number;
  /** 和弦音（pitch class 序列，根音在前） */
  tones: number[];
  seventh: boolean;
}

interface ChordShape {
  third?: number;
  fifth?: number;
  seventh?: number;
}

function analyzeChord(rootPc: number, tonesPc: number[]): ChordShape {
  const ints = [...new Set(tonesPc.map((t) => ((t - rootPc) % 12 + 12) % 12))].sort((a, b) => a - b);
  const third = ints.find((i) => i === 3 || i === 4);
  const fifth = ints.find((i) => i === 6 || i === 7 || i === 8);
  const seventh = ints.includes(11) ? 11 : ints.includes(10) ? 10 : ints.includes(9) ? 9 : undefined;
  return { third, fifth, seventh };
}

/** 由根音（pitch class）与和弦音推导出和弦符号后缀（不含根音名） */
export function chordQuality(rootPc: number, tonesPc: number[]): string {
  const { third, fifth, seventh } = analyzeChord(rootPc, tonesPc);
  if (third === undefined || fifth === undefined) return '';
  if (seventh === undefined) {
    if (fifth === 6) return 'dim';
    if (fifth === 8) return 'aug';
    if (third === 3) return 'm';
    return '';
  }
  const dimTriad = fifth === 6;
  const minorTriad = third === 3 && !dimTriad;
  if (dimTriad) return seventh === 10 ? 'm7\u266D5' : 'dim7';
  if (minorTriad) return seventh === 11 ? 'm(maj7)' : 'm7';
  return seventh === 11 ? 'maj7' : '7';
}

/**
 * 由（调性中心、音阶音程、级数、该级上的音级集合）拼出带升/降号的根音名。
 * 依据级数的字母序号确定自然名，再按实际音级与其差值得出升降号。
 */
function spellScaleRoot(rootPc: number, intervals: number[], degree: number): string {
  const scalePc = ((rootPc % 12) + 12 + intervals[degree]) % 12;
  const letter = degree % 7;
  const base = LETTER_BASE[letter];
  let alter = ((scalePc - base) % 12 + 12) % 12;
  if (alter > 6) alter -= 12;
  const mark = alter === 1 ? '#' : alter === -1 ? '\u266D' : alter === 2 ? '##' : alter === -2 ? '\u266D\u266D' : '';
  return LETTER_NAMES[letter] + mark;
}

/** 由和弦性质后缀推导罗马级数（大小写与 ° 反映和弦色彩，非调性相对） */
export function numeralFor(degree: number, quality: string): string {
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  const base = ROMAN[degree % 7];
  const dimType = quality.includes('dim') || quality.includes('\u266D5');
  if (dimType) return base.toLowerCase() + '\u00B0';
  const minorType = quality.includes('m') && !quality.includes('maj');
  if (minorType) return base.toLowerCase();
  return base;
}

/** 生成某一音阶上每一个级数的自然和弦（三和弦或七和弦） */
export function diatonicChords(root: number, intervals: number[], sevenths = true): Chord[] {
  const rootPc = ((root % 12) + 12) % 12;
  const n = intervals.length;
  const scalePc = intervals.map((iv) => (rootPc + iv) % 12);
  const out: Chord[] = [];
  for (let d = 0; d < n; d++) {
    const tones = [scalePc[d], scalePc[(d + 2) % n], scalePc[(d + 4) % n]];
    let seventh = false;
    if (n === 7 && sevenths) {
      tones.push(scalePc[(d + 6) % n]);
      seventh = true;
    }
    const quality = chordQuality(scalePc[d], tones);
    const rootName = spellScaleRoot(rootPc, intervals, d);
    out.push({
      degree: d,
      numeral: numeralFor(d, quality),
      symbol: rootName + quality,
      root: scalePc[d],
      tones,
      seventh,
    });
  }
  return out;
}

/** 依据当前正在发声的音高集合，从候选和弦里挑选覆盖最多的那一个（平手取低级别） */
export function suggestChord(chords: Chord[], activePc: number[]): Chord | null {
  if (!chords.length) return null;
  const set = new Set(activePc.map((p) => ((p % 12) + 12) % 12));
  let best: Chord | null = null;
  let bestScore = 0;
  for (const c of chords) {
    let score = 0;
    for (const t of c.tones) if (set.has(((t % 12) + 12) % 12)) score++;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}