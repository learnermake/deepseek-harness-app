/**
 * 子探针：定位"带 token 的登录 URL 用不同客户端请求结果不同"的原因。
 * 依次用 node:http / fetch / fetch+浏览器头 请求同一个 token URL，并打印响应头。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const DSH_BIN = process.argv[2];
const WORKDIR = process.argv[3] ?? 'D:/deepseek-harness/workspace';
const log = (...a) => console.log('[auth]', ...a);

const child = spawn(process.execPath, [DSH_BIN, 'web', '--port', '0', '--no-open'], {
  cwd: WORKDIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});

function waitForUrl() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 120000);
    const scan = (c) => {
      const m = c.toString().match(/dsh web:\s*(https?:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
  });
}

function get(url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers,
    }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 'ERR', error: e.message }));
    req.end();
  });
}

const url = await waitForUrl();
const origin = new URL(url).origin;
log('url      =', url);
log('origin   =', origin);

const cases = [
  ['node:http 原样 URL', url, {}],
  ['node:http 裸 origin', origin + '/', {}],
  ['fetch 原样 URL', url, null],
  ['fetch + Chrome UA', url, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' }],
  ['fetch + Accept: text/html', url, { accept: 'text/html,application/xhtml+xml' }],
  ['fetch + Sec-Fetch-*', url, {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    'accept-language': 'zh-CN,zh;q=0.9',
  }],
];

for (const [label, target, headers] of cases) {
  if (headers === null) {
    try {
      const r = await fetch(target, { redirect: 'follow' });
      const body = await r.text();
      log(`${label}: ${r.status} ${body.length}B set-cookie=${r.headers.get('set-cookie') ? 'yes' : 'no'}`);
    } catch (e) { log(`${label}: ERR ${e.message}`); }
  } else {
    const r = await get(target, headers);
    log(`${label}: ${r.status} ${r.bytes}B set-cookie=${r.headers?.['set-cookie'] ? 'yes' : 'no'}`);
    if (r.status === 401) log('   401 响应体:', JSON.stringify(r.headers));
  }
}

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1500));
