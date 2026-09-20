'use strict';

/**
 * 应用与 harness 的路径与常量。
 * 设计要点：外壳（app.asar）与 harness 版本树完全分离，harness 可独立升级/回滚。
 */

const path = require('node:path');
const { app } = require('electron');

/** harness 版本树根目录：%APPDATA%\DeepSeekHarness\harness */
function harnessRoot() {
  return path.join(app.getPath('userData'), 'harness');
}

/** 某个版本的树目录 */
function harnessDir(version) {
  return path.join(harnessRoot(), version);
}

/** 版本指针文件 */
function currentPointerFile() {
  return path.join(harnessRoot(), 'current.json');
}

/**
 * 随包分发的首发 harness。
 * 打包形态是 harness-bundle.tar.gz（原因见 electron-builder.config.cjs 注释：
 * electron-builder 会过滤 extraResources 里的 node_modules 目录）。
 * 开发态仍然可能是解开的目录。
 */
function bundledHarnessDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'harness-bundle')
    : path.join(app.getAppPath(), 'harness-bundle');
}

/** 随包 harness 归档路径（不存在则为 null） */
function bundledHarnessArchive() {
  const fs = require('node:fs');
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'harness-bundle.tar.gz')]
    : [path.join(app.getAppPath(), 'harness-bundle.tar.gz')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/** dsh CLI 入口 */
function dshBin(harnessDirPath) {
  return path.join(harnessDirPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** 日志目录：%APPDATA%\DeepSeekHarness\logs */
function logsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

/** 设置文件：%APPDATA%\DeepSeekHarness\settings.json */
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 解析用来承载 harness 的 node 运行时。
 *
 * 为什么不能直接用 process.execPath：在 Electron 主进程里它是 electron.exe，
 * 拿它去 spawn 会再起一个 Electron 实例，而不是 node。
 *
 * 优先级：
 *   1) 随包分发的 node（resources/node/node.exe）—— 终端用户无需自备 Node
 *   2) DSH_NODE_PATH 环境变量（开发/排障用）
 *   3) PATH 上的 node.exe
 *   4) Electron 自带 node 模式（ELECTRON_RUN_AS_NODE=1）—— 开发态兜底
 */
function resolveNodeRuntime() {
  const fs = require('node:fs');
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'node', 'node.exe')
    : path.join(app.getAppPath(), 'node-runtime', 'node.exe');
  if (fs.existsSync(bundled)) return { exe: bundled, env: {}, source: 'bundled' };

  if (process.env.DSH_NODE_PATH && fs.existsSync(process.env.DSH_NODE_PATH)) {
    return { exe: process.env.DSH_NODE_PATH, env: {}, source: 'DSH_NODE_PATH' };
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try { if (fs.existsSync(candidate)) return { exe: candidate, env: {}, source: 'PATH' }; } catch { /* ignore */ }
  }

  return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'electron-as-node' };
}

const DEFAULTS = {
  /** 新会话的默认工作目录；空 = 用用户主目录 */
  workspace: '',
  /** 监听端口；0 = 由系统分配（推荐，避免端口冲突） */
  port: 0,
  /**
   * harness 的 npm registry。留空 = 官方源。
   * 这是"自定义 registry 的配置点"：只读写设置文件，暂不做 UI。
   */
  registry: '',
  /** 是否在启动时检查 harness 更新 */
  checkHarnessUpdateOnStart: false,
};

module.exports = {
  DEFAULTS,
  harnessRoot,
  harnessDir,
  currentPointerFile,
  bundledHarnessDir,
  bundledHarnessArchive,
  dshBin,
  logsDir,
  settingsFile,
  resolveNodeRuntime,
};
