'use strict';

/**
 * 从 harness 前端自带的 favicon.svg 生成 build/icon.ico（electron-builder 会自动取用）。
 * 依赖：Microsoft Edge（无头渲染 SVG）+ System.Drawing（PNG → 多尺寸 ICO）。
 *
 * 用法：node scripts/create-icon.mjs [svg路径]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outIco = path.join(root, 'build', 'icon.ico');

function findSvg() {
  if (process.argv[2]) return process.argv[2];
  const candidates = [
    path.join(root, 'assets', 'favicon.svg'),
    path.join(root, 'harness-bundle', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 favicon.svg，请作为参数传入');
}

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('找不到 msedge.exe');
}

const svgPath = findSvg();
console.log('[icon] 源矢量:', svgPath);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-icon-'));
const svg = fs.readFileSync(svgPath, 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:256px;height:256px;background:#ffffff;}
#w{width:256px;height:256px;display:flex;align-items:center;justify-content:center;}
#w svg{width:212px;height:212px;}
</style></head><body><div id="w">${svg}</div></body></html>`;
const htmlPath = path.join(work, 'icon.html');
fs.writeFileSync(htmlPath, html, 'utf8');

const pngPath = path.join(work, 'icon.png');
execFileSync(findEdge(), [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=256,256', '--default-background-color=FFFFFFFF',
  `--user-data-dir=${path.join(work, 'profile')}`,
  `--screenshot=${pngPath}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`,
], { stdio: 'inherit' });

// PNG → 多尺寸 ICO：直接写 ICO 容器，避免依赖额外库
const sizes = [16, 24, 32, 48, 64, 128, 256];
const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${JSON.stringify(pngPath)})
$sizes = @(${sizes.join(',')})
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $frames += , @{ Size = $s; Bytes = $ms.ToArray() }
  $ms.Dispose()
}
$src.Dispose()
New-Item -ItemType Directory -Force -Path ${JSON.stringify(path.dirname(outIco))} | Out-Null
$fs = [System.IO.File]::Create(${JSON.stringify(outIco)})
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($f in $frames) {
    $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$f.Bytes.Length); $bw.Write([UInt32]$offset)
    $offset += $f.Bytes.Length
  }
  foreach ($f in $frames) { $bw.Write($f.Bytes) }
} finally { $bw.Dispose(); $fs.Dispose() }
Write-Output ${JSON.stringify(outIco)}
`;
const ps1 = path.join(work, 'ico.ps1');
fs.writeFileSync(ps1, script, 'utf8');
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit' });

fs.rmSync(work, { recursive: true, force: true });
console.log('[icon] 完成:', outIco, fs.statSync(outIco).size, 'bytes');
