'use strict';

/**
 * 在 Electron 之外验证 harness 更新模块的"查询"部分。
 * paths.js 依赖 electron 的 app；这里先往 require 缓存里塞一个假的 electron 模块。
 */

const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');

const userData = path.join(os.tmpdir(), 'dsh-updater-probe');
const fakeElectron = {
  app: {
    isPackaged: false,
    getAppPath: () => path.join(__dirname, '..'),
    getPath: () => userData,
  },
};
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.apply(this, arguments);
};
void originalResolve;

(async () => {
  const { listVersions, registryOf, resolveNpmCli } = require('../src/main/harness-updater');
  const { resolveNodeRuntime } = require('../src/main/paths');

  console.log('[updater-probe] node runtime:', JSON.stringify(resolveNodeRuntime()));
  console.log('[updater-probe] npm cli:', resolveNpmCli());
  console.log('[updater-probe] registry:', registryOf());

  const info = await listVersions({});
  console.log('[updater-probe] dist-tags:', JSON.stringify(info.distTags));
  console.log('[updater-probe] latest:', info.latest, '| stableLatest:', info.stableLatest);
  console.log('[updater-probe] 版本总数:', info.all.length);
  console.log('[updater-probe] 最近 6 个:', info.all.slice(-6).join(', '));
  console.log('[updater-probe] PASS');
})().catch((error) => {
  console.error('[updater-probe] FAIL:', error.message);
  process.exit(1);
});
