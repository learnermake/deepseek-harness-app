/**
 * 把 harness-bundle 打成 tar.gz，供打包分发。
 *
 * 为什么必须打 tar：electron-builder 会过滤掉 extraResources 里的 node_modules 目录，
 * 直接分发目录会导致打进去的 harness 只剩几个文件（实测踩过）。
 *
 * 用法：node scripts/pack-bundle.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = path.join(root, 'harness-bundle');
const out = path.join(root, 'harness-bundle.tar.gz');

const bin = path.join(source, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!fs.existsSync(bin)) {
  console.error('[pack-bundle] harness-bundle 不完整，先运行: node scripts/create-bundle.mjs');
  process.exit(1);
}

if (fs.existsSync(out)) fs.rmSync(out);
console.log('[pack-bundle] 打包', source, '->', out);
execFileSync('tar.exe', ['-czf', out, '-C', source, '.'], { stdio: 'inherit' });
console.log(`[pack-bundle] 完成: ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
