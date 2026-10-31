// 打包 Windows 便携版 EXE：release/SoundWeave-win32-x64/SoundWeave.exe
// 用法：npm run exe（会先构建 dist/）
import { packager } from '@electron/packager';
import * as asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const out = path.join(ROOT, 'release');
const target = path.join(out, 'SoundWeave-win32-x64');

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先运行 npm run build');
  process.exit(1);
}

// 只把运行所需内容打进 app.asar：dist/ + electron/main.cjs + package.json
function ignore(relPath) {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel === '' || rel === 'package.json') return false;
  const first = rel.split('/')[0];
  return !new Set(['dist', 'electron']).has(first);
}

// 临时目录放在项目同盘：packager 用 rename 把成品从临时目录搬到 out，
// 跨盘（C: → E:）在 Windows 上会报 EPERM。
const tmpdir = path.join(ROOT, 'work', 'packager-tmp');
fs.rmSync(tmpdir, { recursive: true, force: true });
fs.mkdirSync(tmpdir, { recursive: true });

// 兜底：某些 Windows 环境（杀毒/索引器持有目录句柄）会拒绝 packager 内部的目录 rename，
// 此时直接用本地 Electron 运行时手工拼装，产物结构相同。
async function buildManually() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) {
    throw new Error('未找到本地 Electron 运行时（node_modules/electron/dist），请先 npm install');
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(dist, target, { recursive: true });
  fs.rmSync(path.join(target, 'resources', 'default_app.asar'), { force: true });

  const stage = path.join(ROOT, 'work', 'app-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'electron'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'dist'), path.join(stage, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'electron', 'main.cjs'), path.join(stage, 'electron', 'main.cjs'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
  await asar.createPackage(stage, path.join(target, 'resources', 'app.asar'));
  fs.renameSync(path.join(target, 'electron.exe'), path.join(target, 'SoundWeave.exe'));
  fs.rmSync(stage, { recursive: true, force: true });
  return [target];
}

let appPaths;
try {
  appPaths = await packager({
    dir: ROOT,
    name: 'SoundWeave',
    appVersion: pkg.version,
    platform: 'win32',
    arch: 'x64',
    out,
    tmpdir,
    overwrite: true,
    asar: true,
    prune: true,
    ignore,
    win32metadata: {
      CompanyName: 'SoundWeave',
      FileDescription: 'SoundWeave 声织 · 音色编曲工作站',
      ProductName: 'SoundWeave 声织',
      OriginalFilename: 'SoundWeave.exe',
    },
  });
} catch (err) {
  console.log(`packager 失败（${err.code || err.message}），改用本地运行时手工拼装`);
  appPaths = await buildManually();
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true });
}

for (const p of appPaths) {
  const exe = path.join(p, 'SoundWeave.exe');
  const size = fs.existsSync(exe) ? fs.statSync(exe).size : 0;
  console.log(`已生成 ${p}`);
  console.log(`可执行文件：${exe}（${(size / 1024 / 1024).toFixed(1)} MB）`);
}
