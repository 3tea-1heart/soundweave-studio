import type { Preset, PresetMacro, InstrumentType, Note } from './types';
import { loadUserPresets } from './user-presets';

const M = (id: string, name: string, targets: PresetMacro['targets']): PresetMacro => ({ id, name, targets });

const MACROS: Record<string, PresetMacro[]> = {
  ep: [
    M('bright', '明亮', [{ param: 'index', min: 0.7, max: 3.8 }, { param: 'tine', min: 0.05, max: 0.9 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.05, max: 0.65 }]),
    M('grit', '颗粒', [{ param: 'drive', min: 0, max: 0.35 }, { fx: 'chorus', min: 0, max: 0.45 }]),
  ],
  piano: [
    M('bright', '明亮', [{ param: 'brightness', min: 0.2, max: 1.0 }]),
    M('tone', '音色', [{ fx: 'tone', min: 0.55, max: 1.0 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.03, max: 0.55 }]),
  ],
  guitar: [
    M('bright', '明亮', [{ param: 'bright', min: 0.15, max: 0.95 }]),
    M('body', '厚度', [{ fx: 'tone', min: 0.6, max: 1.0 }, { param: 'damping', min: 0.15, max: 0.65 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.03, max: 0.5 }]),
  ],
  lead: [
    M('bright', '明亮', [{ param: 'cutoff', min: 500, max: 4200 }]),
    M('grit', '颗粒', [{ param: 'drive', min: 0, max: 0.5 }, { param: 'resonance', min: 0.15, max: 0.75 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.05, max: 0.6 }]),
    M('motion', '运动', [{ param: 'lfoDepth', min: 0, max: 0.6 }, { fx: 'chorus', min: 0, max: 0.5 }]),
  ],
  pad: [
    M('bright', '明亮', [{ param: 'cutoff', min: 350, max: 2600 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.15, max: 0.8 }]),
    M('motion', '运动', [{ param: 'lfoDepth', min: 0, max: 0.5 }, { fx: 'chorus', min: 0.1, max: 0.7 }]),
    M('warmth', '厚度', [{ param: 'sub', min: 0.05, max: 0.8 }, { param: 'sustain', min: 0.4, max: 0.95 }]),
  ],
  bass: [
    M('punch', '冲击', [{ param: 'decay', min: 0.1, max: 0.6 }, { param: 'resonance', min: 0.2, max: 0.8 }]),
    M('bright', '明亮', [{ param: 'cutoff', min: 220, max: 1600 }]),
    M('grit', '颗粒', [{ param: 'drive', min: 0, max: 0.6 }]),
  ],
  drum: [
    M('punch', '冲击', [{ param: 'punch', min: 0.2, max: 0.95 }, { param: 'decay', min: 0.2, max: 0.8 }]),
    M('tone', '音色', [{ param: 'toneShift', min: 0.2, max: 0.85 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.02, max: 0.4 }]),
  ],
  experimental: [
    M('bright', '明亮', [{ param: 'cutoff', min: 200, max: 5000 }]),
    M('grit', '颗粒', [{ param: 'drive', min: 0.05, max: 0.7 }, { param: 'resonance', min: 0.2, max: 0.9 }]),
    M('motion', '运动', [{ param: 'lfoDepth', min: 0, max: 0.8 }, { fx: 'chorus', min: 0, max: 0.8 }]),
    M('space', '空间', [{ fx: 'sendReverb', min: 0.1, max: 0.85 }]),
  ],
};

function p(
  id: string,
  name: string,
  category: string,
  type: InstrumentType,
  params: Record<string, number>,
  macroKey: keyof typeof MACROS,
  description: string,
  tags: string[],
  usage?: string,
): Preset {
  return { id, name, category, type, params, macros: MACROS[macroKey], description, tags, usage };
}

export const PRESETS: Preset[] = [
  // ---- 电钢琴 8 ----
  p('ep-warm', '暖电钢', '电钢琴', 'ep', { index: 2.0, tine: 0.45, decay: 1.7, sustain: 0.24, release: 0.35, chorus: 0.1, drive: 0.04 }, 'ep',
    '温暖的 FM 电钢，适合流行与抒情段落。', ['温暖', '流行', '和弦'], 'C3–C6'),
  p('ep-clear', '清冽电钢', '电钢琴', 'ep', { index: 1.15, tine: 0.18, decay: 2.3, sustain: 0.3, release: 0.4, chorus: 0.04, drive: 0.02 }, 'ep',
    '干净通透，音头轻，适合快速分解。', ['清亮', '轻快'], 'C3–C6'),
  p('ep-grain', '颗粒电钢', '电钢琴', 'ep', { index: 2.7, tine: 0.55, decay: 1.0, sustain: 0.2, release: 0.3, chorus: 0.06, drive: 0.12 }, 'ep',
    '略带颗粒与失真的复古触感。', ['复古', '颗粒'], 'C3–C6'),
  p('ep-vintage', '复古电钢', '电钢琴', 'ep', { index: 1.9, tine: 0.5, decay: 3.0, sustain: 0.16, release: 0.45, chorus: 0.22, drive: 0.16 }, 'ep',
    '长衰减与轻微合唱，像旧录音里的电钢。', ['复古', '长音'], 'C3–C6'),
  p('ep-fm', 'FM 金属电钢', '电钢琴', 'ep', { index: 3.7, tine: 0.85, decay: 0.55, sustain: 0.12, release: 0.15, chorus: 0.02, drive: 0.05 }, 'ep',
    '明亮金属味的 FM 音色，适合电子化编曲。', ['FM', '明亮', '电子'], 'C3–C6'),
  p('ep-bell', '钟声电钢', '电钢琴', 'ep', { index: 4.3, tine: 0.95, decay: 0.32, sustain: 0.04, release: 0.1, chorus: 0.05, drive: 0.02 }, 'ep',
    '极短衰减的金属钟声，适合点缀与音效。', ['钟声', '点缀'], 'C4–C7'),
  p('ep-soft', '柔光电钢', '电钢琴', 'ep', { index: 0.85, tine: 0.2, decay: 1.3, sustain: 0.28, release: 0.3, chorus: 0.3, drive: 0.0 }, 'ep',
    '低亮度、柔和，适合铺底。', ['柔和', '铺底'], 'C3–C6'),
  p('ep-motion', '流动电钢', '电钢琴', 'ep', { index: 2.3, tine: 0.6, decay: 1.2, sustain: 0.22, release: 0.28, chorus: 0.45, drive: 0.05 }, 'ep',
    '强合唱的流动感，适合氛围段落。', ['氛围', '合唱'], 'C3–C6'),

  // ---- 钢弦吉他 6 ----
  p('gtr-pluck', '钢弦拨奏', '吉他', 'guitar', { damping: 0.42, bright: 0.55 }, 'guitar',
    '物理建模拨弦，明确的拨奏瞬态。', ['钢弦', '拨奏'], 'E3–E5'),
  p('gtr-clear', '清亮分解', '吉他', 'guitar', { damping: 0.35, bright: 0.8 }, 'guitar',
    '高亮度拨弦，适合快速分解和弦。', ['清亮', '分解和弦'], 'E3–E6'),
  p('gtr-dark', '低沉扫弦', '吉他', 'guitar', { damping: 0.55, bright: 0.3 }, 'guitar',
    '低亮度、较厚实的扫弦骨架。', ['低沉', '扫弦'], 'E3–E5'),
  p('gtr-muted', '闷音节奏', '吉他', 'guitar', { damping: 0.78, bright: 0.28 }, 'guitar',
    '短促的闷音质感，配合 mute 奏法更明显。', ['闷音', '节奏'], 'E3–E5'),
  p('gtr-finger', '指弹木感', '吉他', 'guitar', { damping: 0.6, bright: 0.48 }, 'guitar',
    '柔和指弹，长音保留更多。', ['指弹', '柔和'], 'E3–E5'),
  p('gtr-drive', '过载颗粒', '吉他', 'guitar', { damping: 0.45, bright: 0.58, drive: 0.35 }, 'guitar',
    '带失真的颗粒，适合律动段落。', ['失真', '颗粒'], 'E3–E5'),

  // ---- 常规钢琴 / 贝斯 8 ----
  p('piano-bright', '明亮钢琴', '钢琴/贝斯', 'piano', { brightness: 0.78, decay: 1.8, sustain: 0.3, release: 0.5 }, 'piano',
    '偏亮的加法钢琴，适合旋律与和声。', ['钢琴', '明亮'], 'C2–C7'),
  p('piano-soft', '柔和钢琴', '钢琴/贝斯', 'piano', { brightness: 0.4, decay: 2.1, sustain: 0.32, release: 0.55 }, 'piano',
    '柔和温暖的钢琴，适合抒情。', ['钢琴', '柔和'], 'C2–C7'),
  p('piano-vintage', '复古钢琴', '钢琴/贝斯', 'piano', { brightness: 0.55, decay: 1.4, sustain: 0.25, release: 0.4 }, 'piano',
    '略旧的音色，带一点干涩。', ['钢琴', '复古'], 'C2–C6'),
  p('piano-wide', '宽银幕钢琴', '钢琴/贝斯', 'piano', { brightness: 0.66, decay: 2.4, sustain: 0.35, release: 0.7 }, 'piano',
    '长衰减、宽空间感的钢琴。', ['钢琴', '电影'], 'C2–C7'),
  p('bass-finger', '指弹贝斯', '钢琴/贝斯', 'bass', { cutoff: 520, resonance: 0.22, sub: 0.35, drive: 0.08, decay: 0.4, sustain: 0.35, filterEnv: 0.45, octave: -12, attack: 0.012 }, 'bass',
    '圆润的指弹贝斯，中低频清晰。', ['贝斯', '圆润'], 'E1–E4'),
  p('bass-electric', '电贝斯', '钢琴/贝斯', 'bass', { cutoff: 700, resonance: 0.3, sub: 0.3, drive: 0.18, decay: 0.3, sustain: 0.32, filterEnv: 0.55, octave: -12, attack: 0.008 }, 'bass',
    '带一点过载的电贝斯。', ['贝斯', '电声'], 'E1–E4'),
  p('bass-upright', '木贝斯', '钢琴/贝斯', 'bass', { cutoff: 380, resonance: 0.15, sub: 0.5, drive: 0.03, decay: 0.55, sustain: 0.4, filterEnv: 0.3, octave: -12, attack: 0.02 }, 'bass',
    '厚实、低频为主的木贝斯替代音色。', ['贝斯', '厚实'], 'E1–E3'),
  p('bass-muted', '闷音贝斯', '钢琴/贝斯', 'bass', { cutoff: 320, resonance: 0.18, sub: 0.45, drive: 0.1, decay: 0.22, sustain: 0.22, filterEnv: 0.5, octave: -12, attack: 0.006 }, 'bass',
    '短促、克制的闷音贝斯。', ['贝斯', '短促'], 'E1–E4'),

  // ---- 合成贝斯 8 ----
  p('bass-sub', '深潜 Sub', '合成贝斯', 'bass', { wave: 0, cutoff: 260, resonance: 0.12, sub: 0.85, drive: 0.05, detune: 0, decay: 0.35, sustain: 0.55, release: 0.3, filterEnv: 0.25, octave: -12, attack: 0.01 }, 'bass',
    '以低频扎实度为主的 sub 贝斯。', ['sub', '低频'], 'C1–C3'),
  p('bass-acid', '酸性 303', '合成贝斯', 'bass', { wave: 0, cutoff: 420, resonance: 0.72, sub: 0.2, drive: 0.35, detune: 3, decay: 0.18, sustain: 0.15, release: 0.18, filterEnv: 0.95, octave: -12, attack: 0.004 }, 'bass',
    '高共振、短促，典型酸性贝斯。', ['acid', '共振'], 'C1–C4'),
  p('bass-funk', '放克拍击', '合成贝斯', 'bass', { wave: 1, cutoff: 520, resonance: 0.48, sub: 0.25, drive: 0.3, detune: 2, decay: 0.16, sustain: 0.2, release: 0.15, filterEnv: 0.9, octave: -12, attack: 0.004, pulseWidth: 0.42 }, 'bass',
    '方波拍击，适合切分律动。', ['放克', '切分'], 'C1–C4'),
  p('bass-deep', '深水贝斯', '合成贝斯', 'bass', { wave: 0, cutoff: 300, resonance: 0.35, sub: 0.6, drive: 0.1, detune: 4, decay: 0.5, sustain: 0.4, release: 0.35, filterEnv: 0.35, octave: -12, attack: 0.015 }, 'bass',
    '沉稳、长衰减的低音铺底。', ['沉稳', '长音'], 'C1–C3'),
  p('bass-dist', '失真推进', '合成贝斯', 'bass', { wave: 0, cutoff: 560, resonance: 0.42, sub: 0.3, drive: 0.55, detune: 5, decay: 0.22, sustain: 0.25, release: 0.2, filterEnv: 0.8, octave: -12, attack: 0.005 }, 'bass',
    '失真推进型贝斯，适合强节奏。', ['失真', '推进'], 'C1–C4'),
  p('bass-octave', '八度跳跃', '合成贝斯', 'bass', { wave: 1, cutoff: 480, resonance: 0.3, sub: 0.3, drive: 0.25, detune: 2, decay: 0.25, sustain: 0.3, release: 0.2, filterEnv: 0.65, octave: -12, attack: 0.006, pulseWidth: 0.5 }, 'bass',
    '适合八度交替线条的合成贝斯。', ['八度', '律动'], 'C1–C4'),
  p('bass-ghost', '鬼魅低音', '合成贝斯', 'bass', { wave: 0, cutoff: 240, resonance: 0.62, sub: 0.4, drive: 0.22, detune: 6, decay: 0.9, sustain: 0.3, release: 0.6, filterEnv: 0.2, octave: -12, attack: 0.05 }, 'bass',
    '暗色、缓慢，适合氛围与实验段落。', ['暗色', '氛围'], 'C1–C3'),
  p('bass-reso', '共振脉冲', '合成贝斯', 'bass', { wave: 1, cutoff: 380, resonance: 0.8, sub: 0.15, drive: 0.3, detune: 1, decay: 0.12, sustain: 0.1, release: 0.12, filterEnv: 1.0, octave: -12, attack: 0.003, pulseWidth: 0.35 }, 'bass',
    '极短脉冲与强共振，适合电子律动。', ['脉冲', '电子'], 'C1–C4'),

  // ---- 主音 / 拨弦 10 ----
  p('lead-bright', '明亮主音', '主音/拨弦', 'synth', { wave: 0, cutoff: 1900, resonance: 0.28, drive: 0.12, detune: 6, sub: 0.08, attack: 0.015, decay: 0.35, sustain: 0.3, release: 0.25, filterEnv: 0.6, lfoDepth: 0.05 }, 'lead',
    '清晰的锯齿主音，适合旋律。', ['主音', '锯齿'], 'C3–C6'),
  p('lead-square', '方波主音', '主音/拨弦', 'synth', { wave: 1, cutoff: 1500, resonance: 0.3, drive: 0.15, detune: 5, sub: 0.1, attack: 0.012, decay: 0.3, sustain: 0.32, release: 0.22, filterEnv: 0.5, pulseWidth: 0.45 }, 'lead',
    '带复古味的方波主音。', ['方波', '复古'], 'C3–C6'),
  p('lead-saw', '锯齿锋芒', '主音/拨弦', 'synth', { wave: 0, cutoff: 2600, resonance: 0.35, drive: 0.22, detune: 9, sub: 0.05, attack: 0.01, decay: 0.25, sustain: 0.28, release: 0.2, filterEnv: 0.75 }, 'lead',
    '更亮更锋利的锯齿主音。', ['明亮', '锋利'], 'C3–C6'),
  p('lead-pluck', '扬琴拨弦', '主音/拨弦', 'synth', { wave: 0, cutoff: 1400, resonance: 0.4, drive: 0.1, detune: 4, sub: 0.06, attack: 0.004, decay: 0.15, sustain: 0.08, release: 0.12, filterEnv: 0.8 }, 'lead',
    '极短拨弦，适合点缀与快速乐句。', ['拨弦', '短音'], 'C3–C6'),
  p('lead-glass', '玻璃拨弦', '主音/拨弦', 'synth', { wave: 1, cutoff: 3000, resonance: 0.55, drive: 0.08, detune: 3, sub: 0.02, attack: 0.004, decay: 0.2, sustain: 0.06, release: 0.15, filterEnv: 0.5, pulseWidth: 0.3 }, 'lead',
    '高频金属般的玻璃拨弦。', ['玻璃', '高频'], 'C4–C6'),
  p('lead-pulse', '电子拨弦', '主音/拨弦', 'synth', { wave: 1, cutoff: 1700, resonance: 0.45, drive: 0.2, detune: 8, sub: 0.12, attack: 0.005, decay: 0.22, sustain: 0.18, release: 0.2, filterEnv: 0.7 }, 'lead',
    '脉冲感明显电子拨弦。', ['电子', '脉冲'], 'C2–C5'),
  p('lead-vibrato', '颤音主音', '主音/拨弦', 'synth', { wave: 0, cutoff: 1600, resonance: 0.25, drive: 0.1, detune: 6, sub: 0.06, attack: 0.02, decay: 0.5, sustain: 0.4, release: 0.3, filterEnv: 0.4, lfoDepth: 0.35, lfoRate: 5.2 }, 'lead',
    '带明显颤音的主音，演奏感更强。', ['颤音', '表现力'], 'C3–C6'),
  p('lead-dream', '梦幻主音', '主音/拨弦', 'synth', { wave: 0, cutoff: 1200, resonance: 0.18, drive: 0.05, detune: 10, sub: 0.15, attack: 0.08, decay: 0.8, sustain: 0.45, release: 0.6, filterEnv: 0.3, lfoDepth: 0.12, chorus: 0.35 }, 'lead',
    '柔和宽大的梦幻主音，适合氛围旋律。', ['梦幻', '氛围'], 'C3–C6'),
  p('lead-stab', '硬核 Stab', '主音/拨弦', 'synth', { wave: 1, cutoff: 2100, resonance: 0.5, drive: 0.3, detune: 4, sub: 0.15, attack: 0.002, decay: 0.12, sustain: 0.05, release: 0.1, filterEnv: 0.9, pulseWidth: 0.5 }, 'lead',
    '短促有力的和弦 stab。', ['stab', '节奏'], 'C3–C6'),
  p('lead-air', '空气口哨', '主音/拨弦', 'synth', { wave: 0, cutoff: 2400, resonance: 0.12, drive: 0.02, detune: 1, sub: 0.0, attack: 0.12, decay: 0.6, sustain: 0.55, release: 0.5, filterEnv: 0.15, lfoDepth: 0.18, lfoRate: 6 }, 'lead',
    '轻飘的单线主音，像口哨与气声。', ['气声', '单线'], 'C4–C6'),

  // ---- 铺底 / 纹理 12 ----
  p('pad-warm', '温暖铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 700, resonance: 0.2, drive: 0.06, detune: 9, sub: 0.35, attack: 0.5, decay: 1.2, sustain: 0.65, release: 1.2, filterEnv: 0.2, lfoDepth: 0.08, chorus: 0.3 }, 'pad',
    '温暖厚实的铺底，适合歌曲背景。', ['温暖', '铺底'], 'C2–C5'),
  p('pad-strings', '弦乐铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 900, resonance: 0.25, drive: 0.08, detune: 12, sub: 0.2, attack: 0.7, decay: 1.6, sustain: 0.7, release: 1.5, filterEnv: 0.15, lfoDepth: 0.05, chorus: 0.4 }, 'pad',
    '接近弦乐队的宽厚铺底。', ['弦乐', '宽厚'], 'C2–C5'),
  p('pad-glass', '玻璃铺底', '铺底/纹理', 'synth', { wave: 1, cutoff: 1600, resonance: 0.4, drive: 0.05, detune: 7, sub: 0.1, attack: 0.4, decay: 1.4, sustain: 0.6, release: 1.3, filterEnv: 0.2, lfoDepth: 0.1, chorus: 0.5 }, 'pad',
    '带玻璃质感的高频铺底。', ['玻璃', '高频'], 'C3–C6'),
  p('pad-space', '深空铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 520, resonance: 0.3, drive: 0.04, detune: 11, sub: 0.4, attack: 1.0, decay: 2.0, sustain: 0.75, release: 2.0, filterEnv: 0.1, lfoDepth: 0.15, chorus: 0.55 }, 'pad',
    '极长起音与释放，氛围铺底。', ['氛围', '长音'], 'C2–C5'),
  p('pad-dark', '暗色铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 360, resonance: 0.35, drive: 0.1, detune: 8, sub: 0.5, attack: 0.6, decay: 1.5, sustain: 0.6, release: 1.4, filterEnv: 0.12, lfoDepth: 0.06 }, 'pad',
    '低亮度暗色铺底，适合悬疑与低频。', ['暗色', '低频'], 'C2–C4'),
  p('pad-light', '光辉铺底', '铺底/纹理', 'synth', { wave: 1, cutoff: 2200, resonance: 0.2, drive: 0.02, detune: 6, sub: 0.05, attack: 0.35, decay: 1.2, sustain: 0.55, release: 1.0, filterEnv: 0.3, chorus: 0.6 }, 'pad',
    '明亮开阔，适合 uplift。', ['光辉', '明亮'], 'C3–C6'),
  p('pad-hollow', '空洞铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 800, resonance: 0.5, drive: 0.1, detune: 14, sub: 0.15, attack: 0.8, decay: 1.8, sustain: 0.5, release: 1.6, filterEnv: 0.2, lfoDepth: 0.2, chorus: 0.35 }, 'pad',
    '中空、飘忽的纹理铺底。', ['空洞', '纹理'], 'C3–C5'),
  p('pad-breath', '呼吸铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 1100, resonance: 0.28, drive: 0.05, detune: 5, sub: 0.2, attack: 1.2, decay: 2.2, sustain: 0.6, release: 2.0, filterEnv: 0.15, lfoDepth: 0.3, lfoRate: 0.4 }, 'pad',
    '缓慢起伏的呼吸感铺底。', ['呼吸', '氛围'], 'C2–C5'),
  p('pad-shimmer', '微光铺底', '铺底/纹理', 'synth', { wave: 1, cutoff: 2600, resonance: 0.45, drive: 0.04, detune: 9, sub: 0.05, attack: 0.6, decay: 1.6, sustain: 0.5, release: 1.5, filterEnv: 0.25, lfoDepth: 0.12, chorus: 0.7 }, 'pad',
    '高频微光与宽合唱，电子氛围。', ['微光', '电子'], 'C3–C6'),
  p('pad-cinema', '电影铺底', '铺底/纹理', 'synth', { wave: 0, cutoff: 600, resonance: 0.22, drive: 0.06, detune: 10, sub: 0.45, attack: 0.9, decay: 2.4, sustain: 0.7, release: 2.2, filterEnv: 0.1, lfoDepth: 0.08, chorus: 0.4 }, 'pad',
    '电影感的低频铺底。', ['电影', '低频'], 'C2–C5'),
  p('pad-choir', '人声铺底', '铺底/纹理', 'synth', { wave: 1, cutoff: 950, resonance: 0.32, drive: 0.04, detune: 16, sub: 0.25, attack: 0.75, decay: 1.7, sustain: 0.68, release: 1.6, filterEnv: 0.18, lfoDepth: 0.1, chorus: 0.5, pulseWidth: 0.62 }, 'pad',
    '像人声合声的宽铺底。', ['人声感', '合声'], 'C3–C5'),
  p('pad-cloud', '云雾纹理', '铺底/纹理', 'synth', { wave: 0, cutoff: 1400, resonance: 0.6, drive: 0.05, detune: 20, sub: 0.1, attack: 1.4, decay: 2.5, sustain: 0.55, release: 2.4, filterEnv: 0.1, lfoDepth: 0.45, lfoRate: 0.25, chorus: 0.45 }, 'pad',
    '缓慢游移的云雾纹理。', ['纹理', '缓慢'], 'C3–C5'),

  // ---- 实验 / 音效 8 ----
  p('exp-metal', '金属实验', '实验/音效', 'synth', { wave: 1, cutoff: 2800, resonance: 0.9, drive: 0.4, detune: 2, sub: 0.1, attack: 0.01, decay: 0.5, sustain: 0.2, release: 0.5, filterEnv: 0.6, pulseWidth: 0.2 }, 'experimental',
    '强共振金属声，适合实验段落。', ['金属', '实验'], 'C3–C6'),
  p('exp-noise', '噪声纹理', '实验/音效', 'synth', { wave: 0, cutoff: 3600, resonance: 0.85, drive: 0.5, detune: 24, sub: 0.0, attack: 0.005, decay: 0.3, sustain: 0.1, release: 0.2, filterEnv: 0.9 }, 'experimental',
    '高频噪声感，接近风与摩擦声。', ['噪声', '摩擦'], 'C2–C6'),
  p('exp-underwater', '水下脉冲', '实验/音效', 'synth', { wave: 0, cutoff: 500, resonance: 0.7, drive: 0.15, detune: 6, sub: 0.6, attack: 0.08, decay: 0.5, sustain: 0.25, release: 0.6, filterEnv: 0.4, lfoRate: 1.1, lfoDepth: 0.4 }, 'experimental',
    '低频脉冲与水感，适合氛围。', ['水感', '脉冲'], 'C2–C4'),
  p('exp-laser', '激光扫频', '实验/音效', 'synth', { wave: 1, cutoff: 3200, resonance: 0.6, drive: 0.25, detune: 0, sub: 0.0, attack: 0.002, decay: 0.1, sustain: 0.02, release: 0.12, filterEnv: 1.0, pulseWidth: 0.2 }, 'experimental',
    '极短扫频，用于转场与音效。', ['扫频', '音效'], 'C4–C7'),
  p('exp-robot', '机器人声', '实验/音效', 'synth', { wave: 1, cutoff: 1200, resonance: 0.65, drive: 0.35, detune: 2, sub: 0.2, attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.3, filterEnv: 0.5, lfoRate: 14, lfoDepth: 0.6 }, 'experimental',
    '快速调制出机器人般的电子声。', ['机器人', '调制'], 'C3–C6'),
  p('exp-tape', '磁带抖动', '实验/音效', 'synth', { wave: 0, cutoff: 800, resonance: 0.35, drive: 0.3, detune: 18, sub: 0.25, attack: 0.05, decay: 0.8, sustain: 0.4, release: 0.8, filterEnv: 0.25, lfoRate: 5.5, lfoDepth: 0.5 }, 'experimental',
    '抖动失真的磁带质感。', ['磁带', '失真'], 'C2–C5'),
  p('exp-storm', '风暴低频', '实验/音效', 'synth', { wave: 0, cutoff: 300, resonance: 0.55, drive: 0.45, detune: 26, sub: 0.7, attack: 0.6, decay: 2.0, sustain: 0.5, release: 2.0, filterEnv: 0.1, lfoRate: 0.6, lfoDepth: 0.35, chorus: 0.3 }, 'experimental',
    '低频轰鸣的纹理，适合氛围。', ['低频', '纹理'], 'C1–C3'),
  p('exp-siren', '警笛扫频', '实验/音效', 'synth', { wave: 1, cutoff: 2200, resonance: 0.45, drive: 0.2, detune: 0, sub: 0.05, attack: 0.15, decay: 1.4, sustain: 0.45, release: 0.5, filterEnv: 0.1, lfoRate: 1.8, lfoDepth: 0.8, pulseWidth: 0.3 }, 'experimental',
    '缓慢扫频的警笛感，适合转场。', ['扫频', '转场'], 'C3–C6'),

  // ---- 鼓组 4 ----
  p('drum-house', '电子鼓 House', '鼓组', 'drum', { punch: 0.72, decay: 0.5, toneShift: 0.55, drive: 0.15 }, 'drum',
    '清晰有力的电子鼓组，适合四拍舞曲。', ['电子', 'house'], 'GM 鼓映射'),
  p('drum-lofi', 'Lo-fi 鼓', '鼓组', 'drum', { punch: 0.4, decay: 0.62, toneShift: 0.36, drive: 0.28 }, 'drum',
    '柔和、略闷的 Lo-fi 鼓组。', ['lofi', '柔和'], 'GM 鼓映射'),
  p('drum-hard', '硬核鼓', '鼓组', 'drum', { punch: 0.95, decay: 0.38, toneShift: 0.68, drive: 0.3 }, 'drum',
    '瞬态极强、偏硬的鼓组。', ['硬核', '瞬态'], 'GM 鼓映射'),
  p('drum-exp', '实验鼓', '鼓组', 'drum', { punch: 0.55, decay: 0.75, toneShift: 0.78, drive: 0.42 }, 'drum',
    '偏高频、带失真的实验鼓组。', ['实验', '失真'], 'GM 鼓映射'),
];

export const PRESET_CATEGORIES = ['电钢琴', '吉他', '钢琴/贝斯', '合成贝斯', '主音/拨弦', '铺底/纹理', '实验/音效', '鼓组', '我的音色'];

/** 用户保存的自定义音色（来自 localStorage） */
export function userPresets(): Preset[] {
  return loadUserPresets();
}

/** 内置预设 + 自定义音色，供素材浏览器与查找共用 */
export function allPresets(): Preset[] {
  return PRESETS.concat(userPresets());
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((x) => x.id === id) || loadUserPresets().find((x) => x.id === id);
}

export function defaultPresetForType(type: InstrumentType): Preset {
  const found = PRESETS.find((x) => x.type === type);
  return found || PRESETS[0];
}

/**
 * 预设里属于轨道级效果的参数：应用预设与预设试听共用，保证两条路径听起来一致。
 * synth/bass 的 drive 已在声部内部实现，这里返回 0 以避免双重过载。
 */
export function presetTrackFx(type: InstrumentType, params: Record<string, number>): { drive: number; chorus: number } {
  const voiceDrive = type === 'synth' || type === 'bass';
  return {
    drive: voiceDrive ? 0 : (params.drive ?? 0),
    chorus: params.chorus ?? 0,
  };
}

/**
 * 试听乐句的最小音符长度（拍，按 96 BPM）。
 * 长起音的铺底音色需要足够时间展开，否则试听里只听到起音的一半。
 */
export function auditionMinLength(attackSec = 0): number {
  return attackSec > 0.25 ? (attackSec + 0.8) * (96 / 60) : 0;
}

/** 预设试听乐句（与工程速度无关，用固定相对拍） */
export function auditionNotes(type: InstrumentType, minLength = 0): Array<Omit<Note, 'id'>> {
  const n = (pitch: number, start: number, length: number, velocity = 0.7) => ({
    pitch,
    start,
    length: Math.max(length, minLength),
    velocity,
    articulation: 'normal' as const,
  });
  if (type === 'drum') {
    const out = [];
    for (let bar = 0; bar < 2; bar++) {
      const b = bar * 4;
      out.push(n(36, b, 0.2, 0.9), n(42, b + 0.5, 0.15, 0.55), n(38, b + 1, 0.2, 0.8), n(42, b + 1.5, 0.15, 0.5), n(36, b + 2, 0.2, 0.85), n(42, b + 2.5, 0.15, 0.55), n(38, b + 3, 0.2, 0.8), n(42, b + 3.5, 0.15, 0.5));
    }
    return out;
  }
  if (type === 'guitar') {
    return [
      n(57, 0, 1.0, 0.7), n(60, 0.25, 1.0, 0.72), n(64, 0.5, 1.0, 0.7), n(60, 0.75, 1.0, 0.6),
      n(57, 1.5, 1.0, 0.7), n(60, 1.75, 1.0, 0.65), n(64, 2.0, 1.4, 0.75), n(67, 2.5, 1.2, 0.6),
    ];
  }
  if (type === 'bass') {
    return [n(45, 0, 1.0, 0.8), n(52, 1.2, 0.8, 0.7), n(48, 2.2, 1.0, 0.75), n(43, 3.2, 1.2, 0.8)];
  }
  if (type === 'synth') {
    return [n(64, 0, 0.7, 0.7), n(67, 0.75, 0.7, 0.68), n(72, 1.5, 1.0, 0.8), n(67, 2.75, 1.2, 0.62)];
  }
  // ep / piano：和弦 + 旋律
  return [
    n(57, 0, 1.6, 0.7), n(60, 0.02, 1.6, 0.62), n(64, 0.04, 1.6, 0.66),
    n(72, 1.0, 0.5, 0.75),
    n(53, 1.6, 1.4, 0.65), n(57, 1.62, 1.4, 0.6), n(60, 1.64, 1.4, 0.64), n(69, 2.4, 0.6, 0.7),
    n(55, 3.1, 1.2, 0.6), n(60, 3.12, 1.2, 0.58), n(64, 3.14, 1.2, 0.62),
  ];
}
