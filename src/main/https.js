'use strict';

/**
 * 极简 HTTP(S) 客户端。
 *
 * 为什么不用全局 fetch：Node 的 fetch（undici）在本机优先尝试 IPv6，
 * 而 IPv6 不通时只会等到连接超时——表现为 "fetch failed / Connect Timeout"，
 * 即使同一台机器用 IPv4 访问同一地址完全正常。这里显式 family: 4，避免该问题。
 */

const http = require('node:http');
const https = require('node:https');

/** 发起一次 GET，返回 { status, headers, body } */
function get(url, { headers = {}, timeoutMs = 15000, redirect = 'manual', maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (target, left) => {
      const u = new URL(target);
      const client = u.protocol === 'http:' ? http : https;
      const req = client.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        family: 4,              // ← 关键：强制 IPv4
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (redirect === 'follow' && status >= 300 && status < 400 && location && left > 0) {
            const next = new URL(location, target).toString();
            return attempt(next, left - 1);
          }
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            setCookie: res.headers['set-cookie'] ?? [],
          });
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`请求超时（${timeoutMs}ms）: ${target}`)); });
      req.on('error', reject);
      req.end();
    };
    attempt(url, maxRedirects);
  });
}

/** 取 JSON */
async function getJson(url, options) {
  const res = await get(url, options);
  if (res.status < 200 || res.status >= 300) {
    const error = new Error(`HTTP ${res.status}: ${url}`);
    error.status = res.status;
    throw error;
  }
  return JSON.parse(res.body);
}

module.exports = { get, getJson };
