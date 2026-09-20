/**
 * 冒烟校验：确认一棵 harness 依赖树真的可用。
 * 判定标准：
 *   1. node <tree>/node_modules/@deepseek-ai/dsh/lib/bin.js --version 能输出版本号
 *   2. web 服务能起来，并在 stdout 打印带 token 的登录 URL
 *   3. 用「浏览器式请求」（Accept: text/html）访问该 URL 返回 303 + set-cookie
 *      —— 裸 fetch 返回 401 属正常，见 probe/auth-probe.mjs 的结论
 *   4. 优雅停机后无孤儿进程
 *
 * 用法：node smoke-test.mjs <harness-tree-dir> [port]
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const tree = process.argv[2];
const port = process.argv[3] ?? '0';
if (!tree) { console.error('用法: node smoke-test.mjs <harness-tree-dir> [port]'); process.exit(2); }

const bin = join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const log = (...a) => console.log('[smoke]', ...a);
const result = { tree, version: null, url: null, auth: null, teardown: null, ok: false };

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code, out: out.trim() }));
  });
}

function browserLikeGet(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
    }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, setCookie: Boolean(res.headers['set-cookie']) }));
    });
    req.on('error', (e) => resolve({ status: 'ERR', error: e.message }));
    req.end();
  });
}

if (!existsSync(bin)) { log('bin.js 缺失:', bin); console.log(JSON.stringify(result)); process.exit(1); }

const v = await run(process.execPath, [bin, '--version']);
result.version = v.out.split('\n').pop().trim();
log('版本:', result.version, '(exit', v.code + ')');

log('启动 web --port', port, '--no-open');
const child = spawn(process.execPath, [bin, 'web', '--port', String(port), '--no-open'], {
  cwd: tree, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});

const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('等待登录 URL 超时')), 120000);
  const scan = (c) => {
    const m = c.toString().match(/dsh web:\s*(https?:\/\/\S+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
}).catch((e) => { log('失败:', e.message); return null; });

if (url) {
  result.url = url;
  log('登录 URL:', url);
  result.auth = await browserLikeGet(url);
  log('浏览器式请求:', JSON.stringify(result.auth));
  // 顺带验证裸请求确实被拒（说明 token 门禁在工作）
  const bare = await browserLikeGet(new URL(url).origin + '/');
  log('裸地址:', JSON.stringify(bare));
  result.auth.bareRejected = bare.status === 401;
}

const t0 = Date.now();
child.kill('SIGTERM');
await new Promise((r) => { child.once('exit', r); setTimeout(r, 15000); });
await new Promise((r) => setTimeout(r, 1500));
let orphans = '';
try {
  orphans = execSync(
    `powershell.exe -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'bin.js web' }).Count"`,
    { windowsHide: true },
  ).toString().trim();
} catch { orphans = '?'; }
result.teardown = { ms: Date.now() - t0, orphanCount: orphans };
log('停机耗时', result.teardown.ms, 'ms，残留 bin.js web 进程数:', orphans);

result.ok = Boolean(result.version)
  && result.auth?.status === 303
  && result.auth?.setCookie === true
  && result.auth?.bareRejected === true
  && orphans === '0';
log('结论:', result.ok ? 'PASS ✅' : 'FAIL ❌');
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
