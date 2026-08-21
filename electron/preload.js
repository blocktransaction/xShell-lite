'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_evt, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    getSecrets: (id) => ipcRenderer.invoke('sessions:get-secrets', id),
  },
  folders: {
    list: () => ipcRenderer.invoke('folders:list'),
    create: (name) => ipcRenderer.invoke('folders:create', name),
    rename: (oldName, newName) => ipcRenderer.invoke('folders:rename', oldName, newName),
    delete: (name) => ipcRenderer.invoke('folders:delete', name),
  },
  dialog: {
    selectPrivateKey: () => ipcRenderer.invoke('dialog:select-private-key'),
    selectUploadFiles: () => ipcRenderer.invoke('dialog:select-upload-files'),
    selectDownloadDir: () => ipcRenderer.invoke('dialog:select-download-dir'),
  },
  sftp: {
    realpath: (connId, remotePath) => ipcRenderer.invoke('sftp:realpath', connId, remotePath),
    list: (connId, remotePath) => ipcRenderer.invoke('sftp:list', connId, remotePath),
    mkdir: (connId, remotePath) => ipcRenderer.invoke('sftp:mkdir', connId, remotePath),
    delete: (connId, remotePath, isDir) => ipcRenderer.invoke('sftp:delete', connId, remotePath, isDir),
    rename: (connId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', connId, oldPath, newPath),
    upload: (connId, localPaths, remoteDir) => ipcRenderer.invoke('sftp:upload', connId, localPaths, remoteDir),
    download: (connId, remoteItems, localDir) => ipcRenderer.invoke('sftp:download', connId, remoteItems, localDir),
    onProgress: (cb) => subscribe('sftp:progress', cb),
  },
  shortcut: {
    create: (sessionId) => ipcRenderer.invoke('shortcut:create', sessionId),
  },
  ssh: {
    connect: (config) => ipcRenderer.invoke('ssh:connect', config),
    write: (id, data) => ipcRenderer.send('ssh:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', { id, cols, rows }),
    disconnect: (id) => ipcRenderer.send('ssh:disconnect', { id }),
    onData: (cb) => subscribe('ssh:data', cb),
    onClosed: (cb) => subscribe('ssh:closed', cb),
    onError: (cb) => subscribe('ssh:error', cb),
  },
  menu: {
    onNewSession: (cb) => subscribe('menu:new-session', cb),
    onCloseTab: (cb) => subscribe('menu:close-tab', cb),
    onAutoConnect: (cb) => subscribe('menu:auto-connect', cb),
  },
});
