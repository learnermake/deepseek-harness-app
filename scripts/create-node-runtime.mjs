'use strict';

/**
 * 从 curl 下载的 node 运行时只保留必要文件即可；此脚本把系统 node 的 npm 复制进
 * node-runtime/npm（刻意放在 node_modules 之外，避免打包时被过滤）。
 *
 * 用法（构建机上执行一次）：
 *   node scripts/create-node-runtime.mjs [node版本] [--npm-from <目录>]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const target = path.join(root, 'node-runtime');
const version = process.argv[2] ?? 'v26.4.0';
const npmFromIndex = process.argv.indexOf('--npm-from');
const npmFrom = npmFromIndex >= 0
  ? process.argv[npmFromIndex + 1]
  : path.join(path.dirname(process.execPath), 'node_modules', 'npm');

const log = (...a) => console.log('[node-runtime]', ...a);

fs.mkdirSync(target, { recursive: true });

const nodeExe = path.join(target, 'node.exe');
if (!fs.existsSync(nodeExe)) {
  const zip = path.join(root, `.node-${version}-win-x64.zip`);
  const url = `https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`;
  log(`下载 ${url}`);
  execFileSync('curl.exe', ['-L', '--fail', '-o', zip, url], { stdio: 'inherit' });
  log('解压…');
  execFileSync('tar.exe', ['-xf', zip, '-C', target], { stdio: 'inherit' });
  const inner = fs.readdirSync(target).find((n) => n.startsWith('node-') && fs.statSync(path.join(target, n)).isDirectory());
  if (!inner) throw new Error('解压后找不到 node 目录');
  fs.renameSync(path.join(target, inner, 'node.exe'), nodeExe);
  fs.rmSync(path.join(target, inner), { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
}

if (!fs.existsSync(npmFrom)) throw new Error(`找不到 npm 源目录：${npmFrom}（用 --npm-from 指定）`);
const npmTo = path.join(target, 'npm');
log(`复制 npm：${npmFrom} -> ${npmTo}`);
fs.rmSync(npmTo, { recursive: true, force: true });
fs.cpSync(npmFrom, npmTo, { recursive: true });

const nodeVersion = execFileSync(nodeExe, ['-v'], { windowsHide: true }).toString().trim();
const npmVersion = execFileSync(nodeExe, [path.join(npmTo, 'bin', 'npm-cli.js'), '--version'], { windowsHide: true }).toString().trim();
log(`完成：node ${nodeVersion} / npm ${npmVersion}`);
