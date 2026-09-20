'use strict';

/**
 * 验证 harness 更新通道的完整暂存链路：下载 → 安装 → 冒烟校验。
 * 不切换当前版本（那会改 %APPDATA% 的指针），只验证"能不能装出可用的一棵树"。
 *
 * 用法: node probe/stage-probe.cjs [版本]
 */

const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const userData = path.join(os.tmpdir(), 'dsh-updater-probe');
const fakeElectron = {
  app: { isPackaged: false, getAppPath: () => path.join(__dirname, '..'), getPath: () => userData },
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.apply(this, arguments);
};

const version = process.argv[2] ?? '0.1.6-alpha.2';

(async () => {
  const { stageVersion } = require('../src/main/harness-updater');
  console.log(`[stage-probe] 目标版本: ${version}`);
  const started = Date.now();
  const result = await stageVersion(version, {
    onLog: (line) => process.stdout.write(`  ${line}`),
    onProgress: (m) => console.log(`[stage-probe] ${m}`),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  let files = 0; let bytes = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  })(result.tempRoot);

  console.log(`[stage-probe] 完成: 版本 ${result.version}, ${files} 文件, ${(bytes / 1024 / 1024).toFixed(1)} MB, 耗时 ${seconds}s`);
  console.log('[stage-probe] 临时树:', result.tempRoot);
  console.log('[stage-probe] PASS');
  fs.rmSync(result.tempRoot, { recursive: true, force: true });
})().catch((error) => {
  console.error('[stage-probe] FAIL:', error.message);
  process.exit(1);
});
