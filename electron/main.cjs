// SoundWeave 声织 · Electron 桌面宿主（Windows EXE）
// 职责：创建窗口、以自定义 app:// 协议提供 dist/ 静态文件、处理保存对话框与 MIDI 权限。
const { app, BrowserWindow, Menu, dialog, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.SOUNDWEAVE_DEV || '';
const SMOKE_OUT = (() => {
  const i = process.argv.indexOf('--smoke-out');
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
})();
// 自检时用固定目录代替「另存为」对话框，便于无人值守验证导出链路
const SMOKE_SAVE_DIR = process.env.SOUNDWEAVE_SMOKE_SAVE || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

// 自定义协议必须较早注册为特权协议，否则页面拿不到 localStorage / AudioWorklet 等能力
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/** 把 app://soundweave/xxx 映射为 dist/xxx；Vite 用相对路径，因此页面可直接工作 */
async function handleAppRequest(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (!rel || rel === '/') rel = '/index.html';
  const file = path.join(DIST_DIR, rel);
  // 只允许读取 dist/ 内的文件
  if (!path.resolve(file).startsWith(path.resolve(DIST_DIR))) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function saveDialogFilters(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.wav')) return [{ name: 'WAV 音频', extensions: ['wav'] }];
  if (lower.endsWith('.mid') || lower.endsWith('.midi')) return [{ name: 'MIDI 文件', extensions: ['mid', 'midi'] }];
  if (lower.endsWith('.json')) return [{ name: '工程 / JSON', extensions: ['json'] }];
  return [];
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#111013',
    title: 'SoundWeave 声织 · 音色编曲工作站',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // 阻止页面被导航到外部地址（只允许 app:// 与可选的开发服务器）
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('app://') || (DEV_URL && url.startsWith(DEV_URL));
    if (!allowed) event.preventDefault();
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else void win.loadURL('app://soundweave/index.html');

  if (SMOKE_OUT) runSmoke(win, SMOKE_OUT);
  return win;
}

/** 自检：加载页面 → 点击播放 → 读取状态栏与引擎信息 → 写结果文件后退出 */
function runSmoke(win, outPath) {
  const logs = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    logs.push(typeof d === 'object' && d && d.message ? `[${d.level}] ${d.message}` : String(args[2] ?? args[0]));
  });
  const finish = (payload) => {
    try {
      fs.writeFileSync(outPath, JSON.stringify({ ...payload, logs: logs.slice(-30) }, null, 2), 'utf8');
    } catch (err) {
      console.error('smoke write failed', err);
    }
    app.exit(payload.ok ? 0 : 1);
  };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 20000);
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const data = await win.webContents.executeJavaScript(`(async () => {
          const q = (id) => (document.getElementById(id)?.textContent ?? '').trim();
          document.getElementById('btn-play').click();
          await new Promise((r) => setTimeout(r, 1800));
          document.getElementById('btn-play').click();
          const beforeExport = q('status');
          document.getElementById('btn-wav-export').click();
          const statusHistory = [];
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 800));
            statusHistory.push(q('status'));
          }
          return {
            status: q('status'),
            beforeExport,
            statusHistory,
            info: q('timeline-info'),
            engine: q('engine-info'),
            position: q('position'),
            midi: q('midi-info'),
          };
        })()`);
        clearTimeout(timer);
        finish({ ok: data.info.includes('轨') && data.engine.length > 0, ...data });
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, reason: String(err) });
      }
    }, 1200);
  });
}

app.setName('SoundWeave');
app.setAppUserModelId('com.soundweave.studio');

app.whenReady().then(() => {
  protocol.handle('app', handleAppRequest);
  Menu.setApplicationMenu(null);

  const ses = session.defaultSession;
  // 只放行 Web MIDI（枚举与输入），其余权限一律拒绝
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'midi' || permission === 'midiSysex');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'midi' || permission === 'midiSysex');

  // 导出 WAV / MIDI / 工程：弹出另存为对话框（浏览器版是直接下载到默认目录）
  ses.on('will-download', (_event, item) => {
    const name = item.getFilename();
    const target = SMOKE_SAVE_DIR
      ? path.join(SMOKE_SAVE_DIR, name)
      : dialog.showSaveDialogSync({
          title: '保存文件',
          defaultPath: path.join(app.getPath('documents'), name),
          filters: saveDialogFilters(name),
        });
    if (!target) {
      item.cancel();
      return;
    }
    item.setSavePath(target);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
