'use strict';

/** 渲染层：只做状态展示与按钮转发，业务逻辑都在主进程 */

const $ = (id) => document.getElementById(id);

const overlay = $('overlay');
const phaseMsg = $('phase-msg');
const errorBox = $('error-box');
const errorText = $('error-text');
const logsEl = $('logs');
const settingsEl = $('settings');

let settings = {};

function show(node, visible) { node.classList.toggle('hidden', !visible); }

function renderState(state) {
  phaseMsg.textContent = state.message ?? '';
  $('ver').textContent = state.version ?? '…';
  $('root').textContent = state.harnessRoot ?? '';
  settings = state.settings ?? settings;

  const failed = state.phase === 'error';
  show(errorBox, failed);
  if (failed) errorText.textContent = state.message ?? '未知错误';

  if (state.url && state.phase === 'ready') {
    overlay.classList.add('hidden');   // 露出 harness 界面
  } else {
    overlay.classList.remove('hidden');
  }

  if (state.logs) {
    logsEl.textContent = state.logs.join('\n');
    logsEl.scrollTop = logsEl.scrollHeight;
  }
  renderVersions();
}

function renderVersions() {
  $('cur-version').textContent = window.__harness?.version ?? '…';
  $('prev-version').textContent = window.__harness?.pointer?.previous ?? '—';
  $('cur-workspace').textContent = settings.workspace || '（用户主目录）';
  $('input-registry').value = settings.registry ?? '';
  $('input-port').value = settings.port ?? 0;
}

async function refreshHarness() {
  window.__harness = await window.dsh.harnessCurrent();
  renderVersions();
}

function showResult(node, payload, okLabel) {
  node.classList.remove('hidden');
  if (payload?.ok) {
    node.classList.remove('error');
    node.textContent = okLabel(payload);
  } else {
    node.classList.add('error');
    node.textContent = payload?.error ?? '失败';
  }
}

// ── 事件 ──────────────────────────────────────────────────────────────────────

$('btn-settings').addEventListener('click', async () => {
  await refreshHarness();
  show(settingsEl, true);
});
$('btn-close-settings').addEventListener('click', () => show(settingsEl, false));

$('btn-restart').addEventListener('click', () => window.dsh.restart());
$('btn-logs').addEventListener('click', () => window.dsh.openLogs());
$('btn-quit').addEventListener('click', () => window.dsh.quit());
$('btn-open-logs').addEventListener('click', () => window.dsh.openLogs());

$('btn-pick-workspace').addEventListener('click', async () => {
  const picked = await window.dsh.pickWorkspace();
  if (picked !== null) {
    settings.workspace = picked;
    renderVersions();
  }
});

$('btn-harness-check').addEventListener('click', async () => {
  const node = $('harness-result');
  node.classList.remove('hidden');
  node.classList.remove('error');
  node.textContent = '正在查询 registry…';
  const info = await window.dsh.harnessCheck();
  if (!info.ok) { node.classList.add('error'); node.textContent = info.error; return; }

  const behind = info.latest && info.latest !== info.current;
  node.innerHTML = '';
  const p = document.createElement('div');
  p.textContent = `当前 ${info.current} · registry 最新 ${info.latest}${behind ? '（可更新）' : '（已是最新）'}`;
  node.appendChild(p);

  const list = document.createElement('div');
  list.className = 'versions';
  (info.all ?? []).slice(-8).reverse().forEach((v) => {
    const b = document.createElement('button');
    b.textContent = v;
    b.className = 'chip';
    b.addEventListener('click', async () => {
      if (!confirm(`把 harness 更新到 ${v}？更新期间会重启 harness 服务。`)) return;
      node.textContent = `正在更新到 ${v}…（下载并校验，可能需要几分钟）`;
      const result = await window.dsh.harnessUpdate(v);
      showResult(node, result, (r) => `已更新到 ${r.version}（上一个：${r.previous ?? '无'}）`);
      await refreshHarness();
    });
    list.appendChild(b);
  });
  node.appendChild(list);
});

$('btn-harness-rollback').addEventListener('click', async () => {
  const node = $('harness-result');
  if (!confirm('回滚到上一个 harness 版本？')) return;
  node.classList.remove('hidden');
  node.textContent = '正在回滚…';
  const result = await window.dsh.harnessRollback();
  showResult(node, result, (r) => `已回滚到 ${r.version}`);
  await refreshHarness();
});

$('btn-app-check').addEventListener('click', async () => {
  const node = $('app-result');
  node.classList.remove('hidden');
  node.textContent = '正在检查应用更新…';
  const result = await window.dsh.appCheckUpdate();
  showResult(node, result, (r) => `发现新版本 ${r.version ?? '（已是最新）'}`);
});

$('btn-save-advanced').addEventListener('click', async () => {
  const registry = $('input-registry').value.trim();
  const port = Number($('input-port').value || 0);
  settings = await window.dsh.setSettings({ registry, port });
  renderVersions();
  alert('已保存。端口或 registry 变更后请重启 harness 生效。');
});

// ── 启动 ──────────────────────────────────────────────────────────────────────

window.dsh.onState(renderState);
window.dsh.onLog((line) => {
  logsEl.textContent += `${line}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
});

window.dsh.getState().then(renderState).catch((error) => {
  show(errorBox, true);
  errorText.textContent = `无法读取应用状态：${error.message}`;
});
refreshHarness().catch(() => {});
