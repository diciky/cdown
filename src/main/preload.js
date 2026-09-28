// TDM Fast - preload：安全暴露 IPC 桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdm', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  addTask: (url, opts = {}) => ipcRenderer.invoke('tasks:add', { url, ...opts }),
  pause: id => ipcRenderer.invoke('tasks:pause', id),
  resume: id => ipcRenderer.invoke('tasks:resume', id),
  remove: id => ipcRenderer.invoke('tasks:remove', id),
  pauseAll: () => ipcRenderer.invoke('tasks:pauseAll'),
  clearCompleted: () => ipcRenderer.invoke('tasks:clearCompleted'),
  restart: id => ipcRenderer.invoke('tasks:restart', id),
  sniffUrl: url => ipcRenderer.invoke('sniff:url', url),
  exportLinks: () => ipcRenderer.invoke('tasks:exportLinks'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  showItem: p => ipcRenderer.invoke('shell:showItem', p),
  onTasksUpdated: cb => ipcRenderer.on('tasks-updated', (_e, tasks) => cb(tasks)),
  onTaskDone: cb => ipcRenderer.on('task-done', (_e, s) => cb(s)),
  onTaskError: cb => ipcRenderer.on('task-error', (_e, s) => cb(s)),
  onAddFailed: cb => ipcRenderer.on('add-failed', (_e, s) => cb(s)),
  onClipboardUrl: cb => ipcRenderer.on('clipboard-url', (_e, url) => cb(url)),
  markClipboardHandled: () => ipcRenderer.invoke('clipboard:markHandled'),
  copyText: text => ipcRenderer.invoke('clipboard:copyText', text)
});
