'use strict';

/**
 * 依赖树许可证盘点：
 *   1. 列出顶层 node_modules 里每个包声明的 license 字段
 *   2. 对"未声明"的包，检查它目录下是否真的带 LICENSE/COPYING 文件（有文件≠无授权）
 *   3. 找出谁依赖了这些包（即它是否真的会被加载）
 *
 * 用法: node probe/license-audit.cjs <node_modules目录>
 */

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root || !fs.existsSync(root)) { console.error('用法: node probe/license-audit.cjs <node_modules目录>'); process.exit(2); }

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

function licenseOf(pkg) {
  if (!pkg) return { value: '(package.json 不可读)', raw: null };
  // 新版字段
  if (typeof pkg.license === 'string' && pkg.license.trim()) return { value: pkg.license.trim(), raw: 'license' };
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return { value: pkg.license.type, raw: 'license.type' };
  // 旧版字段
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const joined = pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
    if (joined) return { value: joined, raw: 'licenses[]' };
  }
  return { value: null, raw: null };
}

function findLicenseFiles(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((n) => /^(licen[cs]e|copying|notice|copyright)/i.test(n));
}

/** 收集所有包目录（含 @scope/name 一层） */
function collectPackages(nm) {
  const out = [];
  const walkDir = (base, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.bin') continue;
      if (e.name.startsWith('@')) { walkDir(path.join(base, e.name), `${prefix}${e.name}/`); continue; }
      out.push({ name: `${prefix}${e.name}`, dir: path.join(base, e.name) });
    }
  };
  walkDir(nm, '');
  return out;
}

const packages = collectPackages(root);
console.log(`扫描到 ${packages.length} 个包（顶层 node_modules，含 scope 一层）\n`);

const noFieldNoFile = [];
const noFieldButFile = [];
const byLicense = new Map();

for (const p of packages) {
  const pkg = readPkg(p.dir);
  const { value, raw } = licenseOf(pkg);
  if (value) {
    byLicense.set(value, (byLicense.get(value) ?? 0) + 1);
    continue;
  }
  const files = findLicenseFiles(p.dir);
  if (files.length) noFieldButFile.push({ ...p, files, version: pkg?.version });
  else noFieldNoFile.push({ ...p, version: pkg?.version, hasPkgJson: Boolean(pkg) });
}

// 反向依赖：谁依赖了这些包
const targets = new Set([...noFieldNoFile, ...noFieldButFile].map((p) => p.name));
const dependents = new Map();
for (const p of packages) {
  const pkg = readPkg(p.dir);
  if (!pkg) continue;
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const dep of Object.keys(pkg[section] ?? {})) {
      if (targets.has(dep)) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(`${p.name}(${section})`);
      }
    }
  }
}

console.log('=== 许可证字段分布（有声明的）===');
[...byLicense.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

console.log(`\n=== A. 既无 license 字段、也没有 LICENSE 文件：${noFieldNoFile.length} 个 ===`);
for (const p of noFieldNoFile) {
  const deps = dependents.get(p.name) ?? [];
  console.log(`  ${p.name}@${p.version ?? '?'}`);
  console.log(`      被依赖: ${deps.length ? deps.slice(0, 4).join(', ') : '（无人依赖 → 可能是 npm 自动装入的多余包）'}`);
}

console.log(`\n=== B. 无 license 字段，但目录里带许可证文件：${noFieldButFile.length} 个 ===`);
for (const p of noFieldButFile) {
  const deps = dependents.get(p.name) ?? [];
  console.log(`  ${p.name}@${p.version ?? '?'}  文件: ${p.files.join(', ')}`);
  console.log(`      被依赖: ${deps.length ? deps.slice(0, 4).join(', ') : '（无人依赖）'}`);
}

console.log('\n=== C. 含 LGPL / GPL / AGPL 字样的包（需单独判断）===');
for (const p of packages) {
  const { value } = licenseOf(readPkg(p.dir));
  if (value && /(L|A)GPL|GPL/i.test(value)) {
    const deps = dependents.get(p.name) ?? [];
    console.log(`  ${p.name}@${readPkg(p.dir)?.version}  license=${value}`);
  }
}
