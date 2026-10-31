// 桌面 EXE 自检：启动打包好的 SoundWeave.exe → 播放 → 导出 WAV → 校验结果
// 用法：npm run exe:smoke（需先 npm run exe）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXE = path.join(ROOT, 'release', 'SoundWeave-win32-x64', 'SoundWeave.exe');
const WORK = path.join(ROOT, 'work', 'exe-smoke');
const RESULT = path.join(WORK, 'result.json');

if (!fs.existsSync(EXE)) {
  console.error(`未找到 ${EXE}，请先运行 npm run exe`);
  process.exit(1);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const child = spawn(EXE, ['--smoke-out', RESULT], {
  env: { ...process.env, SOUNDWEAVE_SMOKE_SAVE: WORK },
  stdio: 'ignore',
});
const timer = setTimeout(() => {
  console.log('自检超时（40 s），终止进程');
  child.kill();
}, 40000);

child.on('exit', (code) => {
  clearTimeout(timer);
  check('EXE 正常退出', code === 0, `exit=${code}`);

  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  } catch {
    check('自检结果文件', false, RESULT);
  }
  if (!result) {
    console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(1);
  }

  check('页面已加载（时间轴信息）', /\d+ 轨/.test(result.info || ''), result.info);
  check('音频引擎运行', /运行中/.test(result.engine || ''), result.engine);
  check('播放推进', result.position !== '1.1', `position=${result.position}`);
  check('导出成功提示', /已导出 WAV/.test(result.status || ''), result.status);
  check('控制台无警告/错误', (result.logs || []).length === 0, (result.logs || []).slice(0, 3).join(' | '));

  const wavs = fs.readdirSync(WORK).filter((f) => f.toLowerCase().endsWith('.wav'));
  check('生成了 WAV 文件', wavs.length === 1, wavs.join(','));
  if (wavs.length === 1) {
    const buf = fs.readFileSync(path.join(WORK, wavs[0]));
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bits = buf.readUInt16LE(34);
    const dataBytes = buf.readUInt32LE(40);
    check(
      'WAV 头合法（RIFF/WAVE · 48 kHz · 16-bit · 时长 > 0）',
      buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WAVE' &&
        sampleRate === 48000 &&
        bits === 16 &&
        channels === 2 &&
        dataBytes > 0,
      `${channels}ch ${sampleRate}Hz ${bits}bit ${(dataBytes / (sampleRate * channels * 2)).toFixed(2)}s`,
    );
  }

  console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`自检产物：${WORK}`);
  process.exit(fail === 0 ? 0 : 1);
});
