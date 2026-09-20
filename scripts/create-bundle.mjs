'use strict';

/**
 * 生成/更新内置 harness bundle（随应用分发的首发版本）。
 *
 * 用法：
 *   node scripts/create-bundle.mjs                  # 用 package.json 里 pin 的版本
 *   node scripts/create-bundle.mjs 0.1.6-alpha.2    # 指定版本
 *   node scripts/create-bundle.mjs --from <已有树>   # 直接复制一棵已验证可用的树（离线）
 *
 * 安装参数为什么是这三个（都是实测结论，别改）：
 *   --omit=dev       只装运行时依赖
 *   --ignore-scripts 跳过 koffi 的 install（缺 CMake 的机器上必失败；预编译二进制另有来源）
 *   不加 --omit=optional：koffi 原生模块来自可选依赖 @koromix/koffi-win32-x64
 * 形态为什么是"包装项目"：根目录只依赖 @deepseek-ai/dsh 一个包。
 *   直接以 dsh 包为根会把它的运行时依赖（含 npm 上不存在的实验包）当生产依赖解析 → 404。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bundleDir = path.join(root, 'harness-bundle');
const args = process.argv.slice(2);

const fromIndex = args.indexOf('--from');
const fromTree = fromIndex >= 0 ? args[fromIndex + 1] : null;
const wantVersion = args.find((a) => !a.startsWith('--') && a !== fromTree) ?? '0.1.5-rc.2';

const log = (...a) => console.log('[bundle]', ...a);

function treeIsUsable(dir) {
  return fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
}

function treeVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version;
  } catch { return null; }
}

function copyTree(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop();
    const from = rel ? path.join(source, rel) : source;
    const to = rel ? path.join(target, rel) : target;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) { fs.mkdirSync(toPath, { recursive: true }); stack.push(childRel); }
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(fromPath), toPath);
      else fs.copyFileSync(fromPath, toPath);
      n += 1;
    }
  }
  return n;
}

if (fromTree) {
  if (!treeIsUsable(fromTree)) { console.error('给定的树不可用:', fromTree); process.exit(1); }
  log(`从已有树复制: ${fromTree} -> ${bundleDir}`);
  const n = copyTree(fromTree, bundleDir);
  log(`完成：${n} 个文件，版本 ${treeVersion(bundleDir)}`);
  process.exit(0);
}

log(`安装 ${wantVersion} 到 ${bundleDir}`);
fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });

fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
  name: 'dsh-harness-bundle',
  private: true,
  description: 'Bundled DeepSeek Harness runtime tree; updated independently of the app shell.',
  dependencies: { '@deepseek-ai/dsh': wantVersion },
}, null, 2), 'utf8');
fs.writeFileSync(path.join(bundleDir, '.npmrc'), 'fund=false\naudit=false\n', 'utf8');

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCmd = fs.existsSync(npmCli) ? process.execPath : 'npm';
const npmArgs = [
  ...(fs.existsSync(npmCli) ? [npmCli] : []),
  'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
];

execFileSync(npmCmd, npmArgs, {
  cwd: bundleDir,
  stdio: 'inherit',
  env: { ...process.env, npm_config_allow_scripts: '' },
});

if (!treeIsUsable(bundleDir)) { console.error('安装完成但缺少 dsh 入口'); process.exit(1); }

const size = execFileSync(process.execPath, ['-e', `
  const fs=require('fs'),path=require('path');
  let files=0,bytes=0;
  (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);
    if(e.isDirectory())walk(f);else{files++;bytes+=fs.statSync(f).size;}}})(${JSON.stringify(bundleDir)});
  console.log(files+' '+bytes);
`], { windowsHide: true }).toString().trim().split(' ');

log(`完成：版本 ${treeVersion(bundleDir)}，${size[0]} 个文件，${(Number(size[1]) / 1024 / 1024).toFixed(1)} MB`);
