'use strict';

/**
 * 设置读写 + harness 版本树的解析/落位。
 *
 * 版本树布局（%APPDATA%\DeepSeekHarness\harness）：
 *   current.json          {"current":"0.1.5-rc.2","previous":"0.1.4","bundled":"0.1.5-rc.2"}
 *   <version>/            完整的 harness 依赖树（内含 node_modules/@deepseek-ai/dsh）
 */

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, harnessRoot, harnessDir, currentPointerFile, bundledHarnessDir, bundledHarnessArchive, settingsFile, dshBin } = require('./paths');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadSettings() {
  return { ...DEFAULTS, ...(readJson(settingsFile(), {}) || {}) };
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJson(settingsFile(), next);
  return next;
}

/** 读版本树里的 harness 版本号 */
function versionOfTree(dir) {
  const pkg = readJson(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  return pkg?.version ?? null;
}

function isUsableTree(dir) {
  return Boolean(dir) && fs.existsSync(dshBin(dir));
}

function readPointer() {
  return readJson(currentPointerFile(), null);
}

/**
 * 确保"当前使用的 harness 版本树"存在。
 * 首次运行：把打包进来的 harness-bundle 复制到版本目录（%APPDATA%），
 * 这样后续升级/回滚都在用户数据区进行，不需要写安装目录（避免 UAC）。
 */
function ensureCurrentTree({ onProgress } = {}) {
  const root = harnessRoot();
  fs.mkdirSync(root, { recursive: true });

  const pointer = readPointer();

  // 1) 指针指向的树可用 → 直接用
  if (pointer?.current) {
    const dir = harnessDir(pointer.current);
    if (isUsableTree(dir)) return { dir, version: pointer.current, pointer, seeded: false };
  }

  // 2) 已解包的任何可用版本树（按指针的 previous 兜底）
  if (pointer?.previous) {
    const dir = harnessDir(pointer.previous);
    if (isUsableTree(dir)) {
      const version = versionOfTree(dir) ?? pointer.previous;
      writeJson(currentPointerFile(), { ...pointer, current: pointer.previous });
      return { dir, version, pointer: { ...pointer, current: pointer.previous }, seeded: false, fellBack: true };
    }
  }

  // 3) 首次运行：从随包分发的 harness 播种（tar.gz 归档，或开发态的解包目录）
  const archive = bundledHarnessArchive();
  const source = bundledHarnessDir();

  if (archive) {
    const version = archiveVersion(archive) ?? 'bundled';
    const target = harnessDir(version);
    if (!isUsableTree(target)) {
      onProgress?.(`首次运行：正在解包内置 harness ${version}（约 213MB，请稍候）…`);
      extractArchive(archive, target, onProgress);
    }
    if (!isUsableTree(target)) throw new Error(`解包后仍缺少 harness 入口：${target}`);
    const next = { current: version, previous: pointer?.previous ?? null, bundled: version };
    writeJson(currentPointerFile(), next);
    return { dir: target, version, pointer: next, seeded: true };
  }

  if (!isUsableTree(source)) {
    throw new Error(`随包分发的 harness 缺失：既没有 ${archive ?? '(归档)'} 也没有可用的 ${source}`);
  }
  const version = versionOfTree(source) ?? 'bundled';
  const target = harnessDir(version);

  if (!isUsableTree(target)) {
    onProgress?.(`首次运行：正在释放内置 harness ${version}（约 213MB，请稍候）…`);
    copyTree(source, target, onProgress);
  }

  const next = { current: version, previous: pointer?.previous ?? null, bundled: version };
  writeJson(currentPointerFile(), next);
  return { dir: target, version, pointer: next, seeded: true };
}

/** 读取归档内 harness 的版本号（顺便完成完整性校验：解压前先列表） */
function archiveVersion(archive) {
  const output = runTar(['-tzf', archive], archive);
  const match = output.match(/\.?\/?node_modules\/@deepseek-ai\/dsh\/package\.json\s*$/m);
  if (!match) return null;
  // 用 tar 直接抽取那一个文件读取版本号
  try {
    const text = runTar(['-xzOf', archive, './node_modules/@deepseek-ai/dsh/package.json'], archive);
    return JSON.parse(text).version ?? null;
  } catch {
    try {
      const text2 = runTar(['-xzOf', archive, 'node_modules/@deepseek-ai/dsh/package.json'], archive);
      return JSON.parse(text2).version ?? null;
    } catch { return null; }
  }
}

/** 解包归档到目标目录（tar 自带列表 + 解压，失败即抛） */
function extractArchive(archive, target, onProgress) {
  fs.mkdirSync(target, { recursive: true });
  const listing = runTar(['-tzf', archive], archive);
  const entries = listing.split('\n').filter(Boolean).length;
  onProgress?.(`归档内 ${entries} 个条目，开始解包…`);
  runTar(['-xzf', archive, '-C', target], archive);
  onProgress?.('解包完成');
}

function runTar(args, archive) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('tar.exe', args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch (error) {
    const detail = (error.stderr?.toString() ?? '').trim();
    throw new Error(`tar ${args[0]} 失败（${archive}）：${detail || error.message}`);
  }
}

/** 复制依赖树（保留符号链接语义，逐项复制以便报告进度） */
function copyTree(source, target, onProgress) {
  fs.mkdirSync(target, { recursive: true });
  const stack = [['', '']];
  let copied = 0;
  while (stack.length) {
    const [rel] = stack.pop();
    const from = rel ? path.join(source, rel) : source;
    const to = rel ? path.join(target, rel) : target;
    const entries = fs.readdirSync(from, { withFileTypes: true });
    for (const entry of entries) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        fs.mkdirSync(toPath, { recursive: true });
        stack.push([entryRel]);
      } else if (entry.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(fromPath), toPath);
      } else {
        fs.copyFileSync(fromPath, toPath);
      }
      copied += 1;
      if (copied % 4000 === 0) onProgress?.(`已复制 ${copied} 个文件…`);
    }
  }
  onProgress?.(`内置 harness 释放完成（${copied} 个文件）`);
}

/** 切换当前版本（升级成功 / 回滚时调用） */
function switchCurrent(version, { keepPrevious = true } = {}) {
  const pointer = readPointer() ?? {};
  const next = {
    ...pointer,
    previous: keepPrevious ? pointer.current ?? null : pointer.previous ?? null,
    current: version,
  };
  writeJson(currentPointerFile(), next);
  return next;
}

module.exports = {
  loadSettings,
  saveSettings,
  readJson,
  writeJson,
  readPointer,
  versionOfTree,
  isUsableTree,
  ensureCurrentTree,
  switchCurrent,
  copyTree,
};
