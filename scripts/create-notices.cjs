'use strict';

/**
 * 生成第三方许可证清单（THIRD-PARTY-NOTICES.txt）。
 *
 * 为什么需要：
 *   - MIT/Apache-2.0/BSD 都要求在分发时随附许可证与版权声明
 *   - 依赖树里有一个 LGPL-3.0-or-later 的组件（sharp 的 libvips 部分，
 *     经 @img/sharp-win32-x64 分发），LGPL 允许随应用分发，但必须给出声明
 *
 * 该组件是可动态替换的独立 npm 包（@img/sharp-win32-x64 公开发布），
 * 因此满足 LGPL "可替换库" 的要求，不需要开放外壳本身的源码。
 *
 * 用法: node scripts/create-notices.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'harness-bundle', 'node_modules');
const out = path.join(root, 'THIRD-PARTY-NOTICES.txt');

if (!fs.existsSync(nm)) {
  console.error('[notices] 找不到 harness-bundle/node_modules，先运行 npm run bundle:create');
  process.exit(1);
}

function collect(dir, prefix = '') {
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) { found.push(...collect(path.join(dir, entry.name), `${prefix}${entry.name}/`)); continue; }
    const pkgDir = path.join(dir, entry.name);
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { continue; }
    found.push({
      name: `${prefix}${entry.name}`,
      version: pkg.version,
      license: typeof pkg.license === 'string'
        ? pkg.license
        : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : '(未声明)')),
      homepage: pkg.homepage ?? pkg.repository?.url ?? '',
      dir: pkgDir,
    });
  }
  return found;
}

const packages = collect(nm).sort((a, b) => a.name.localeCompare(b.name));
const counts = new Map();
for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);

const lines = [];
lines.push('DeepSeek Harness 桌面应用 — 第三方组件许可证清单');
lines.push('='.repeat(64));
lines.push('');
lines.push(`本应用随包分发以下第三方组件，共 ${packages.length} 个。`);
lines.push('各组件的版权归其各自作者所有，均按其声明的许可证分发。');
lines.push('');
lines.push('许可证汇总：');
for (const [license, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`  ${String(n).padStart(4)}  ${license}`);
}
lines.push('');
lines.push('说明：其中含 LGPL-3.0-or-later 的组件为 @img/sharp-win32-x64（sharp 所用的');
lines.push('libvips 预编译发行版）。该组件作为独立、可替换的 npm 包公开发布，');
lines.push('符合 LGPL 关于动态链接/可替换库的要求。');
lines.push('');
lines.push('-'.repeat(64));
lines.push('');

for (const p of packages) {
  lines.push(`${p.name}@${p.version}`);
  lines.push(`  License : ${p.license}`);
  if (p.homepage) lines.push(`  Source  : ${p.homepage}`);
  // 附上许可证正文（若包内自带）
  const files = fs.readdirSync(p.dir).filter((n) => /^(licen[cs]e|copying)/i.test(n));
  const chosen = files[0];
  if (chosen) {
    try {
      const text = fs.readFileSync(path.join(p.dir, chosen), 'utf8').trim();
      if (text.length <= 20000) {
        lines.push(`  --- ${chosen} ---`);
        for (const l of text.split(/\r?\n/)) lines.push(`  ${l}`);
      } else {
        lines.push(`  (许可证正文过长，见包内 ${chosen})`);
      }
    } catch { /* 读取失败则只列字段 */ }
  }
  lines.push('');
}

// 主程序自身
lines.push('='.repeat(64));
lines.push('主程序');
lines.push('');
lines.push('DeepSeek Harness (@deepseek-ai/dsh) — MIT License');
lines.push('  https://github.com/deepseek-ai/deepseek-harness');
lines.push('');
lines.push('Node.js — MIT License, 见随包 node/LICENSE');
lines.push('Electron — MIT License, 见应用目录 LICENSE.electron.txt');
lines.push('');

fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`[notices] 已生成 ${out}`);
console.log(`[notices] ${packages.length} 个组件，${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
