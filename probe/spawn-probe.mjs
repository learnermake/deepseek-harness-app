/**
 * 关键风险验证（不属于最终产品代码）
 * ---------------------------------
 * 验证 Electron 外壳依赖的三件事：
 *   1. spawn `node <dsh>/lib/bin.js web --port 0 --no-open` 时无控制台窗口
 *   2. 能从 stdout 抓到带 token 的登录 URL（就绪信号）
 *   3. 退出时能优雅回收子进程及其派生的整棵进程树（不留孤儿）
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const DSH_BIN = process.argv[2]
  ?? 'C:/Users/shan/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js';
const WORKDIR = process.argv[3] ?? 'D:/deepseek-harness/workspace';
const PORT = process.argv[4] ?? '0';

const log = (...a) => console.log('[probe]', ...a);

if (!existsSync(DSH_BIN)) { console.error('找不到 bin.js:', DSH_BIN); process.exit(2); }

log('spawn:', process.execPath, DSH_BIN, `web --port ${PORT} --no-open`);
const child = spawn(process.execPath, [DSH_BIN, 'web', '--port', String(PORT), '--no-open'], {
  cwd: WORKDIR,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let url = null;
const urlReady = new Promise((resolve) => {
  const scan = (chunk, tag) => {
    const text = chunk.toString();
    process.stdout.write(`[${tag}] ${text}`);
    if (!url) {
      const m = text.match(/dsh web:\s*(https?:\/\/\S+)/);
      if (m) { url = m[1]; resolve(url); }
    }
  };
  child.stdout.on('data', (c) => scan(c, 'out'));
  child.stderr.on('data', (c) => scan(c, 'err'));
});

let exitInfo = null;
child.on('exit', (code, signal) => { exitInfo = { code, signal }; log('child exit:', code, signal); });

const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms));

const result = { step1_spawn: false, step2_url: null, step3_http: null, step4_tree_before: 0, step5_killed: null, step6_orphans: null };

try {
  result.step1_spawn = child.pid > 0;
  log('child pid =', child.pid);

  const got = await Promise.race([urlReady, timeout(120000, '等待登录 URL 超时')]);
  result.step2_url = got;
  log('捕获登录 URL:', got);

  await new Promise((r) => setTimeout(r, 500));
  const res = await fetch(got, { redirect: 'follow' });
  const body = await res.text();
  result.step3_http = { status: res.status, bytes: body.length };
  log('HTTP:', res.status, body.length, 'bytes');

  const { execSync } = require('node:child_process');
  const before = execSync(
    `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'bin.js web' }).ProcessId -join ','"`,
    { windowsHide: true },
  ).toString().trim();
  result.step4_tree_before = before ? before.split(',').length : 0;
  log('回收前 node 进程:', before);

  // 优雅退出：先 SIGTERM，超时再强杀整棵树
  const t0 = Date.now();
  child.kill('SIGTERM');
  try { await Promise.race([new Promise((r) => child.once('exit', r)), timeout(15000, 'SIGTERM 后子进程未退出')]); }
  catch {
    log('SIGTERM 无效，改用 taskkill /T /F');
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true }); } catch { /* 可能已退出 */ }
    await Promise.race([new Promise((r) => child.once('exit', r)), timeout(10000, '强杀后仍未退出')]).catch(() => {});
  }
  result.step5_killed = { ms: Date.now() - t0, exit: exitInfo };

  await new Promise((r) => setTimeout(r, 2000));
  const after = execSync(
    `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'bin.js web' }).ProcessId -join ','"`,
    { windowsHide: true },
  ).toString().trim();
  result.step6_orphans = after || '(无)';
  log('回收后 node 进程:', result.step6_orphans);
} catch (error) {
  log('验证失败:', error.message);
} finally {
  if (exitInfo === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  log('结果:', JSON.stringify(result, null, 2));
}
