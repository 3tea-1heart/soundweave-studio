/**
 * 五线谱记谱辅助：MIDI 音高 → 自然音名、临时升降号、八度与谱表步进。
 * 默认采用升号拼写、无调号（C 大调）位置，作为钢琴卷帘的五线谱显示视图基础。
 */

const LETTER_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

export const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
/** 各自然音名的 MIDI 音级（C=0, D=2, …, B=11） */
export const LETTER_BASE = [0, 2, 4, 5, 7, 9, 11];

export interface NoteSpelling {
  /** 自然音名序号 0=C … 6=B */
  letter: number;
  /** 临时升降：正为升（+1=C#），负为降，0 为还原 */
  alter: number;
  /** 科学音高八度（C4 为中央 C） */
  octave: number;
  /** 相对中央 C 的自然音级步进（每级 = 一条线/间） */
  step: number;
  /** 音名文本，如 C#4 / B3 */
  name: string;
}

/** 把 MIDI 音高拆为自然音名 + 临时升号 + 八度 */
export function spellPitch(pitch: number): NoteSpelling {
  const pc = ((pitch % 12) + 12) % 12;
  const letter = LETTER_INDEX[pc];
  const alter = ALTER[pc];
  const octave = Math.round((pitch - alter - LETTER_BASE[letter]) / 12) - 1;
  const step = letter + (octave - 4) * 7;
  return {
    letter,
    alter,
    octave,
    step,
    name: `${LETTER_NAMES[letter]}${alter ? (alter > 0 ? '#' : 'b') : ''}${octave}`,
  };
}

/** 临时升降 → 显示字符 */
export function alterMark(alter: number): string {
  if (alter === 0) return '';
  if (alter === 1) return '\u266F'; // ♯
  if (alter === -1) return '\u266D'; // ♭
  const t = alter > 0 ? '\u266F' : '\u266D';
  return t.repeat(Math.abs(alter));
}