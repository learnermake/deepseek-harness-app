'use strict';

/**
 * harness 更新通道（与"应用本体更新"完全分开）。
 *
 * 流程：查 registry 版本 → 在临时目录按"包装项目"形态安装 → 冒烟校验 → 就位 → 切指针。
 *
 * 关键约束（都是实测撞出来的）：
 *   1. 必须以"包装项目"安装：package.json 里只依赖 @deepseek-ai/dsh。
 *      直接把 dsh 包当根项目会把它的 72 个运行时依赖当生产依赖解析，
 *      其中 @deepseek-ai/dsh-experimental-code-runtime-python 在 npm 上不存在（404），安装必失败。
 *   2. 不能加 --omit=optional：koffi 的原生模块来自可选依赖 @koromix/koffi-win32-x64，
 *      省掉它 koffi 会在运行时抛 "Cannot find the native Koffi module"。
 *   3. 必须加 --ignore-scripts：koffi 的 install 脚本在没有 CMake 的机器上会直接失败；
 *      而它的预编译二进制已由上面的平台包提供，不需要构建。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { harnessRoot, harnessDir, settingsFile, resolveNodeRuntime } = require('./paths');
const { loadSettings, versionOfTree, isUsableTree, copyTree, readJson } = require('./settings');
const { HarnessServer, probeLoginUrl } = require('./harness-server');
const { getJson } = require('./https');

const PACKAGE = '@deepseek-ai/dsh';
const INSTALL_ARGS = [
  'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
  // 网络抖动自愈：npm 默认只重试 2 次、超时 5 分钟，对大依赖树偏紧
  '--fetch-retries=5', '--fetch-retry-mintimeout=2000', '--fetch-retry-maxtimeout=60000',
  '--fetch-timeout=900000',
];

function registryOf(settings = loadSettings()) {
  return (settings.registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

/** 定位 npm 的 CLI 入口：与当前使用的 node 运行时同目录安装的 npm */
function resolveNpmCli() {
  const runtime = resolveNodeRuntime();
  const base = path.dirname(runtime.exe);
  const candidates = [
    // 随包 node 运行时：npm 刻意放在 node_modules 之外，
    // 否则 electron-builder 打包 extraResources 时会把 node_modules 过滤掉
    path.join(base, 'npm', 'bin', 'npm-cli.js'),
    path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function runNode(args, { cwd, env, onLog } = {}) {
  const runtime = resolveNodeRuntime();
  return new Promise((resolve) => {
    const child = execFile(runtime.exe, args, {
      cwd,
      env: { ...process.env, ...runtime.env, ...env },
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
    child.stdout?.on('data', (c) => onLog?.(c.toString()));
    child.stderr?.on('data', (c) => onLog?.(c.toString()));
  });
}

/** 查 registry 上可用的版本 */
async function listVersions({ includePrerelease = true, registry } = {}) {
  const base = registry || registryOf();
  const meta = await getJson(`${base}/${PACKAGE.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    timeoutMs: 20000,
  });
  const versions = Object.keys(meta.versions ?? {});
  const stable = versions.filter((v) => !/-/.test(v));
  return {
    distTags: meta['dist-tags'] ?? {},
    all: versions,
    latest: meta['dist-tags']?.latest ?? versions[versions.length - 1],
    stableLatest: stable[stable.length - 1] ?? null,
    showPrerelease: includePrerelease,
  };
}

/** 把某个版本安装到临时目录并校验 */
async function stageVersion(version, { registry, onLog, onProgress } = {}) {
  const base = registry || registryOf();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-stage-${version}-`));
  const pkg = {
    name: 'dsh-harness-bundle',
    private: true,
    dependencies: { [PACKAGE]: version },
  };
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  fs.writeFileSync(path.join(tempRoot, '.npmrc'), 'fund=false\naudit=false\n', 'utf8');

  const npmCli = resolveNpmCli();
  if (!npmCli) throw new Error('找不到 npm（需要 node 自带的 npm-cli.js）');

  onProgress?.(`正在下载 ${PACKAGE}@${version} 及其依赖…`);
  const install = await runNode([npmCli, ...INSTALL_ARGS, '--registry', base], {
    cwd: tempRoot,
    env: { npm_config_allow_scripts: '' },
    onLog,
  });
  if (install.code !== 0) {
    throw new Error(`安装 ${version} 失败（exit ${install.code}）：${install.stderr.split('\n').slice(-6).join('\n')}`);
  }
  if (!isUsableTree(tempRoot)) throw new Error(`安装完成但缺少 dsh 入口：${tempRoot}`);

  const installed = versionOfTree(tempRoot);
  if (installed !== version) {
    onLog?.(`注意：请求 ${version}，实际解析为 ${installed}`);
  }

  // 冒烟校验：能起服务 + 登录 URL 可换 cookie + 优雅停机
  onProgress?.(`正在校验 ${installed} 能否正常提供服务…`);
  const server = new HarnessServer(tempRoot, { port: 0 });
  try {
    const url = await server.start({ urlTimeoutMs: 180000 });
    const probe = await probeLoginUrl(url);
    if (!probe.ok) throw new Error(`健康校验失败（HTTP ${probe.status}）`);
  } finally {
    await server.stop();
  }

  return { tempRoot, version: installed };
}

/**
 * 执行一次 harness 更新：安装 → 校验 → 就位到版本目录 → 切指针。
 * 注意：切换后需要重启 harness 子进程才会生效（由调用方决定时机）。
 */
async function updateHarness(targetVersion, { onLog, onProgress } = {}) {
  const settings = loadSettings();
  const { tempRoot, version } = await stageVersion(targetVersion, {
    registry: registryOf(settings), onLog, onProgress,
  });

  const dest = harnessDir(version);
  if (isUsableTree(dest)) {
    onProgress?.(`${version} 已存在，跳过复制`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } else {
    onProgress?.(`正在就位到 ${dest}…`);
    copyTree(tempRoot, dest, onProgress);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  // 先写备用指针，再切换（保证中途崩溃也能回滚）
  const pointerFile = path.join(harnessRoot(), 'current.json');
  const pointer = readJson(pointerFile, {}) ?? {};
  fs.mkdirSync(harnessRoot(), { recursive: true });
  fs.writeFileSync(pointerFile, JSON.stringify({
    ...pointer,
    previous: pointer.current ?? null,
    current: version,
  }, null, 2), 'utf8');

  onProgress?.(`harness 已更新到 ${version}（上一个版本：${pointer.current ?? '无'}）`);

  // 磁盘安全阀：每棵树可能几百 MB（依赖版本错配时 npm 会嵌套复制多份），
  // 成功切换后只保留「当前 + 上一个（回滚用）」。
  const removed = pruneOldTrees({ keep: [version, pointer.current].filter(Boolean) }, onProgress);
  if (removed.length) onProgress?.(`已清理旧版本树：${removed.join(', ')}`);

  return { version, previous: pointer.current ?? null, removed };
}

/** 删除除 keep 之外的版本树目录 */
function pruneOldTrees({ keep }, onProgress) {
  const root = harnessRoot();
  if (!fs.existsSync(root)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.includes(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      onProgress?.(`清理旧版本树 ${entry.name}…`);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* 占用中则跳过，下次再清 */ }
  }
  return removed;
}

module.exports = { listVersions, updateHarness, stageVersion, registryOf, resolveNpmCli, settingsFile };
