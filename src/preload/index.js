'use strict';

/** 渲染进程可见的最小 API 面（contextIsolation 打开，不暴露 Node） */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('dsh', {
  getState: () => ipcRenderer.invoke('app:state'),
  restart: () => ipcRenderer.invoke('app:restart'),
  reloadWindow: () => ipcRenderer.invoke('app:reload-window'),
  quit: () => ipcRenderer.invoke('app:quit'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickWorkspace: () => ipcRenderer.invoke('settings:pick-workspace'),

  harnessCurrent: () => ipcRenderer.invoke('harness:current'),
  harnessCheck: () => ipcRenderer.invoke('harness:check'),
  harnessUpdate: (version) => ipcRenderer.invoke('harness:update', version),
  harnessRollback: () => ipcRenderer.invoke('harness:rollback'),

  appCheckUpdate: () => ipcRenderer.invoke('app:check-update'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openLicenses: () => ipcRenderer.invoke('app:open-licenses'),

  onState: (handler) => subscribe('state', handler),
  onLog: (handler) => subscribe('server:log', handler),
});
