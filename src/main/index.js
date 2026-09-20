'use strict';

/**
 * Electron 主进程：窗口生命周期 + harness 进程生命周期。
 * 设计目标：宿主是 GUI 子系统，因此全程没有任何控制台窗口；
 * 应用退出时务必回收 harness 子进程，不留孤儿。
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

const { loadSettings, saveSettings, readPointer, versionOfTree, ensureCurrentTree } = require('./settings');
const { HarnessServer } = require('./harness-server');
const { listVersions, updateHarness, registryOf } = require('./harness-updater');
const { logsDir, harnessDir } = require('./paths');

let mainWindow = null;
let server = null;
let currentTree = null;
let currentVersion = null;
let quitting = false;
let startupError = null;

const state = {
  phase: 'starting',      // starting | extracting | launching | ready | error
  message: '正在启动…',
  version: null,
  url: null,
  logs: [],
};

function pushLog(line) {
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
  broadcast('server:log', line);
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function setPhase(phase, message) {
  state.phase = phase;
  state.message = message ?? state.message;
  broadcast('state', publicState());
}

function publicState() {
  return {
    phase: state.phase,
    message: state.message,
    version: state.version,
    url: state.url,
    logs: state.logs.slice(-80),
    settings: loadSettings(),
    harnessRoot: harnessDir(''),
    logsDir: logsDir(),
  };
}

function showMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 站内导航留在应用窗口，外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (state.url && url.startsWith(new URL(state.url).origin)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

async function bootHarness() {
  setPhase('extracting', '正在准备 harness 运行时…');
  const tree = ensureCurrentTree({ onProgress: (m) => setPhase('extracting', m) });
  currentTree = tree.dir;
  currentVersion = tree.version ?? versionOfTree(tree.dir);
  state.version = currentVersion;

  setPhase('launching', `正在启动 harness ${currentVersion}…`);
  server = new HarnessServer(currentTree, {
    port: loadSettings().port ?? 0,
    workspace: loadSettings().workspace || undefined,
  });
  server.on('log', pushLog);
  server.on('exit', ({ code, signal }) => {
    if (quitting) return;
    setPhase('error', `harness 进程已退出（code=${code} signal=${signal}）。可在设置里重启。`);
  });

  const url = await server.start();
  state.url = url;
  setPhase('ready', `harness ${currentVersion} 已就绪`);
  await mainWindow.loadURL(url);
}

async function restartHarness() {
  if (server) { await server.stop(); server = null; }
  state.url = null;
  state.logs = [];
  try {
    await bootHarness();
    return { ok: true };
  } catch (error) {
    startupError = error;
    setPhase('error', error.message);
    return { ok: false, error: error.message };
  }
}

// ── IPC ────────────────────────────────────────────────────────────────────────

ipcMain.handle('app:state', () => publicState());

ipcMain.handle('app:restart', async () => restartHarness());

ipcMain.handle('app:reload-window', async () => {
  if (state.url) await mainWindow.loadURL(state.url);
  return true;
});

ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (_event, patch) => {
  const next = saveSettings(patch ?? {});
  broadcast('state', publicState());
  return next;
});

ipcMain.handle('settings:pick-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const next = saveSettings({ workspace: result.filePaths[0] });
  broadcast('state', publicState());
  return next.workspace;
});

ipcMain.handle('harness:current', () => ({
  version: currentVersion,
  tree: currentTree,
  registry: registryOf(),
  pointer: readPointer(),
}));

ipcMain.handle('harness:check', async () => {
  try {
    const info = await listVersions({});
    return { ok: true, ...info, current: currentVersion };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

async function runHarnessUpdate(version) {
  try {
    const result = await updateHarness(version, {
      onLog: pushLog,
      onProgress: (m) => setPhase('updating', m),
    });
    pushLog(`[更新] harness ${result.previous ?? '?'} → ${result.version}`);
    const restarted = await restartHarness();
    return { ok: restarted.ok, ...result, restartError: restarted.error };
  } catch (error) {
    setPhase('ready', `更新失败：${error.message}`);
    return { ok: false, error: error.message };
  }
}

ipcMain.handle('harness:update', (_event, version) => {
  if (!version) return { ok: false, error: '未指定版本' };
  return runHarnessUpdate(version);
});

ipcMain.handle('harness:rollback', () => {
  const pointer = readPointer();
  if (!pointer?.previous) return { ok: false, error: '没有可回滚的上一个版本' };
  return runHarnessUpdate(pointer.previous);
});

ipcMain.handle('app:check-update', async () => {
  // 应用本体更新通道（electron-updater）：未配置更新源时明确告知，而不是静默失败
  try {
    const { autoUpdater } = require('electron-updater');
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version ?? null };
  } catch (error) {
    return { ok: false, error: `应用更新源尚未配置：${error.message}` };
  }
});

ipcMain.handle('app:open-logs', async () => {
  await shell.openPath(logsDir());
  return true;
});

async function openLicensesFile() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'licenses', 'THIRD-PARTY-NOTICES.txt')
    : path.join(app.getAppPath(), 'THIRD-PARTY-NOTICES.txt');
  if (!fs.existsSync(file)) {
    const message = `未找到许可证清单：${file}`;
    if (mainWindow) dialog.showMessageBox(mainWindow, { type: 'warning', message });
    return { ok: false, error: message };
  }
  await shell.openPath(file);
  return { ok: true, file };
}

ipcMain.handle('app:open-licenses', () => openLicensesFile());

ipcMain.handle('app:quit', () => { app.quit(); return true; });

// ── 生命周期 ──────────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
/** --smoke：无人值守自检（启动 harness → 健康校验 → 打印结论 → 退出），不显示窗口 */
const SMOKE = process.argv.includes('--smoke');
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (SMOKE) {
      try {
        const tree = ensureCurrentTree({ onProgress: (m) => console.log('[smoke]', m) });
        console.log('[smoke] harness tree:', tree.dir, 'version', tree.version);
        const s = new HarnessServer(tree.dir, { port: 0 });
        s.on('log', (l) => console.log('[server]', l));
        const url = await s.start();
        const { probeLoginUrl } = require('./harness-server');
        const probe = await probeLoginUrl(url);
        console.log('[smoke] probe:', JSON.stringify(probe));
        await s.stop();
        const ok = probe.ok;
        console.log('[smoke] 结论:', ok ? 'PASS' : 'FAIL');
        app.exit(ok ? 0 : 1);
      } catch (error) {
        console.error('[smoke] 失败:', error.message);
        app.exit(1);
      }
      return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '重新加载窗口', accelerator: 'CmdOrCtrl+R', click: () => { if (state.url) mainWindow.loadURL(state.url); } },
          { label: '重启 harness', click: () => restartHarness() },
          { type: 'separator' },
          { label: '打开日志目录', click: () => shell.openPath(logsDir()) },
          { label: '第三方许可证', click: () => openLicensesFile() },
          { type: 'separator' },
          { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
    ]));

    showMainWindow();

    try {
      await bootHarness();
    } catch (error) {
      startupError = error;
      pushLog(`[启动失败] ${error.message}`);
      setPhase('error', error.message);
    }
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', async (event) => {
    if (quitting) return;
    quitting = true;
    if (server) {
      event.preventDefault();
      try { await server.stop(); } catch { /* ignore */ }
      app.quit();
    }
  });

  process.on('exit', () => { try { server?.child?.kill(); } catch { /* ignore */ } });
}

module.exports = { publicState, startupError };
