'use strict';

/**
 * harness 服务进程的生命周期管理：
 *   - 以隐藏窗口方式 spawn `node <bin.js> web --port <port> --no-open`
 *   - 从 stdout/stderr 里抓出带 token 的登录 URL（就绪信号）
 *   - 健康校验：浏览器式请求应得 303 + set-cookie（裸请求 401 是 token 门禁的正常表现）
 *   - 优雅停机：SIGTERM → 超时 taskkill /T /F，确保不留孤儿
 *
 * 注意：不要只依赖固定的日志前缀，任何 http URL 都接住，避免上游改了措辞就崩。
 */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dshBin, logsDir, resolveNodeRuntime } = require('./paths');
const { get } = require('./https');

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
const LOG_RING = 200;

class HarnessServer extends EventEmitter {
  constructor(dshTreeDir, options = {}) {
    super();
    this.tree = dshTreeDir;
    this.port = options.port ?? 0;
    this.workspace = options.workspace || undefined;
    this.child = null;
    this.loginUrl = null;
    this.ready = false;
    this.exited = null;
    this.logs = [];
    this._stdout = null;
    this._stderr = null;
  }

  get bin() { return dshBin(this.tree); }

  _push(line) {
    this.logs.push(line);
    if (this.logs.length > LOG_RING) this.logs.splice(0, this.logs.length - LOG_RING);
    this.emit('log', line);
  }

  _scan(text) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._push(trimmed);
      if (!this.loginUrl) {
        const m = trimmed.match(URL_PATTERN);
        if (m) {
          this.loginUrl = m[0];
          this.emit('url', this.loginUrl);
        }
      }
    }
  }

  /** 启动并等待登录 URL；resolve 的 URL 可直接交给 BrowserWindow.loadURL */
  async start({ urlTimeoutMs = 120000 } = {}) {
    if (!fs.existsSync(this.bin)) {
      throw new Error(`harness 运行时缺失：${this.bin}`);
    }

    const logDir = logsDir();
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this._stdout = fs.createWriteStream(path.join(logDir, `server-${stamp}.out.log`), { flags: 'a' });
    this._stderr = fs.createWriteStream(path.join(logDir, `server-${stamp}.err.log`), { flags: 'a' });

    const args = [this.bin, 'web', '--port', String(this.port), '--no-open'];
    const runtime = resolveNodeRuntime();
    this._push(`$ "${runtime.exe}" ${args.join(' ')}  [node 来源: ${runtime.source}]`);

    this.child = spawn(runtime.exe, args, {
      cwd: this.workspace && fs.existsSync(this.workspace) ? this.workspace : undefined,
      windowsHide: true,
      env: { ...process.env, ...runtime.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (c) => { this._stdout.write(c); this._scan(c.toString()); });
    this.child.stderr.on('data', (c) => { this._stderr.write(c); this._scan(c.toString()); });

    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.ready = false;
        this._push(`[退出] code=${code} signal=${signal}`);
        this.emit('exit', { code, signal });
        resolve({ code, signal });
      });
    });

    this.child.once('error', (error) => this._push(`[进程错误] ${error.message}`));

    const url = await Promise.race([
      new Promise((resolve) => this.once('url', resolve)),
      this.exited.then(() => null),
      new Promise((_, reject) => setTimeout(() => reject(new Error('等待 harness 就绪超时')), urlTimeoutMs)),
    ]);

    if (!url) {
      const tail = this.logs.slice(-12).join('\n');
      throw new Error(`harness 启动即退出。日志尾部：\n${tail}`);
    }

    this.ready = true;
    return url;
  }

  /** 真实绑定端口（--port 0 时由系统分配，从登录 URL 里读回） */
  get boundPort() {
    if (!this.loginUrl) return null;
    try { return Number(new URL(this.loginUrl).port) || null; } catch { return null; }
  }

  async stop({ graceMs = 8000 } = {}) {
    if (!this.child || this.child.exitCode !== null) return;
    const child = this.child;
    this._push('[停机] SIGTERM');
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }

    const finished = await Promise.race([
      this.exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), graceMs)),
    ]);

    if (!finished) {
      this._push('[停机] SIGTERM 超时，强制结束整棵进程树');
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 5000))]);
    }

    for (const s of [this._stdout, this._stderr]) { try { s?.end(); } catch { /* ignore */ } }
  }
}

/**
 * 健康校验：用"浏览器式"请求访问登录 URL。
 * 判定：303 + set-cookie 视为健康（token 被接受）；401 说明 token 未被接受。
 * 只用裸请求会得到 401（服务按请求意图发 cookie），所以必须带 Accept: text/html。
 * 使用 IPv4 强制客户端：全局 fetch 在 IPv6 不通的机器上会连接超时。
 */
async function probeLoginUrl(url, { timeoutMs = 8000 } = {}) {
  try {
    const res = await get(url, {
      redirect: 'manual',
      timeoutMs,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'DeepSeekHarnessDesktop/1.0',
      },
    });
    const accepted = res.status === 303 || res.status === 200;
    return { ok: accepted, status: res.status, setCookie: res.setCookie.length };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

module.exports = { HarnessServer, probeLoginUrl };
