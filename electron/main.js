'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Paths / persistent storage
// ---------------------------------------------------------------------------

const userDataDir = app.getPath('userData');
const SESSIONS_FILE = path.join(userDataDir, 'sessions.json');
const KNOWN_HOSTS_FILE = path.join(userDataDir, 'known_hosts.json');
const FOLDERS_FILE = path.join(userDataDir, 'folders.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read', file, err);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadSessions() {
  return readJson(SESSIONS_FILE, []);
}

function saveSessions(sessions) {
  writeJson(SESSIONS_FILE, sessions);
}

function loadKnownHosts() {
  return readJson(KNOWN_HOSTS_FILE, {});
}

function saveKnownHosts(hosts) {
  writeJson(KNOWN_HOSTS_FILE, hosts);
}

function loadFolders() {
  return readJson(FOLDERS_FILE, []);
}

function saveFolders(folders) {
  writeJson(FOLDERS_FILE, folders);
}

// Make sure a folder name exists in the persisted folder list (sessions can
// reference a folder that hasn't been explicitly created, e.g. legacy data).
function ensureFolder(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  const folders = loadFolders();
  if (!folders.includes(trimmed)) {
    folders.push(trimmed);
    folders.sort((a, b) => a.localeCompare(b, 'zh'));
    saveFolders(folders);
  }
}

// ---------------------------------------------------------------------------
// Secret encryption helpers (uses OS keychain via Electron safeStorage when
// available, falls back to a clearly-marked plaintext store otherwise).
// ---------------------------------------------------------------------------

function encryptSecret(plain) {
  if (!plain) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(plain).toString('base64') };
  }
  return { enc: false, data: plain };
}

function decryptSecret(secret) {
  if (!secret) return '';
  if (secret.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(secret.data, 'base64'));
    } catch (err) {
      console.error('Failed to decrypt secret', err);
      return '';
    }
  }
  return secret.data || '';
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 820,
    minHeight: 480,
    backgroundColor: '#1e1f22',
    title: 'xShell Lite',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  Menu.setApplicationMenu(buildMenu());

  // If launched from a per-session desktop shortcut (see shortcut:create),
  // tell the renderer which session to auto-connect once the page is ready.
  const launchSessionId = getLaunchSessionId();
  if (launchSessionId) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('menu:auto-connect', launchSessionId);
    });
  }
}

function getLaunchSessionId() {
  const arg = process.argv.find((a) => a.startsWith('--session='));
  return arg ? arg.slice('--session='.length) : null;
}

function buildMenu() {
  const template = [
    {
      label: '会话',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow && mainWindow.webContents.send('menu:new-session'),
        },
        { type: 'separator' },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow && mainWindow.webContents.send('menu:close-tab'),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 xShell Lite',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'xShell Lite',
              detail: '一个仿照 Xshell 制作的跨平台 SSH 终端客户端。\n基于 Electron + xterm.js + ssh2 构建。',
            });
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const conn of connections.values()) {
    try { conn.client.end(); } catch (_) { /* noop */ }
  }
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

function publicSession(s) {
  // Strip secret material before sending metadata to the renderer.
  const { password, passphrase, ...rest } = s;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

ipcMain.handle('sessions:list', () => {
  return loadSessions().map(publicSession);
});

ipcMain.handle('sessions:get-secrets', (_evt, id) => {
  const s = loadSessions().find((x) => x.id === id);
  if (!s) return null;
  return {
    password: decryptSecret(s.password),
    passphrase: decryptSecret(s.passphrase),
  };
});

ipcMain.handle('sessions:save', (_evt, session) => {
  const sessions = loadSessions();
  const now = Date.now();
  const idx = sessions.findIndex((s) => s.id === session.id);

  const toStore = {
    id: session.id || randomUUID(),
    name: session.name || session.host,
    group: (session.group || '').trim(),
    host: session.host,
    port: session.port || 22,
    username: session.username || '',
    authType: session.authType === 'key' ? 'key' : 'password',
    privateKeyPath: session.privateKeyPath || '',
    createdAt: idx >= 0 ? sessions[idx].createdAt : now,
    updatedAt: now,
  };

  // Only touch secrets if the caller actually supplied new values, so
  // "edit session" without retyping the password doesn't wipe it out.
  if (typeof session.password === 'string' && session.password.length > 0) {
    toStore.password = encryptSecret(session.password);
  } else if (idx >= 0) {
    toStore.password = sessions[idx].password;
  }

  if (typeof session.passphrase === 'string' && session.passphrase.length > 0) {
    toStore.passphrase = encryptSecret(session.passphrase);
  } else if (idx >= 0) {
    toStore.passphrase = sessions[idx].passphrase;
  }

  if (idx >= 0) sessions[idx] = toStore;
  else sessions.push(toStore);

  saveSessions(sessions);
  ensureFolder(toStore.group); // keep the folder list consistent even for legacy/direct callers
  return sessions.map(publicSession);
});

// ---------------------------------------------------------------------------
// Folders (session groups) — created independently of sessions via the
// sidebar "+" menu; sessions reference a folder by name in their `group` field.
// ---------------------------------------------------------------------------

ipcMain.handle('folders:list', () => {
  return loadFolders();
});

ipcMain.handle('folders:create', (_evt, name) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return loadFolders();
  ensureFolder(trimmed);
  return loadFolders();
});

ipcMain.handle('folders:rename', (_evt, oldName, newName) => {
  const from = (oldName || '').trim();
  const to = (newName || '').trim();
  if (!from || !to || from === to) return loadFolders();

  let folders = loadFolders().filter((f) => f !== from);
  if (!folders.includes(to)) folders.push(to);
  folders.sort((a, b) => a.localeCompare(b, 'zh'));
  saveFolders(folders);

  // Cascade onto any sessions filed under the old name.
  const sessions = loadSessions();
  let changed = false;
  for (const s of sessions) {
    if ((s.group || '').trim() === from) { s.group = to; changed = true; }
  }
  if (changed) saveSessions(sessions);

  return folders;
});

ipcMain.handle('folders:delete', (_evt, name) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return loadFolders();

  const folders = loadFolders().filter((f) => f !== trimmed);
  saveFolders(folders);

  // Sessions filed under the deleted folder become ungrouped, not deleted.
  const sessions = loadSessions();
  let changed = false;
  for (const s of sessions) {
    if ((s.group || '').trim() === trimmed) { s.group = ''; changed = true; }
  }
  if (changed) saveSessions(sessions);

  return folders;
});

ipcMain.handle('sessions:delete', (_evt, id) => {
  const sessions = loadSessions().filter((s) => s.id !== id);
  saveSessions(sessions);
  return sessions.map(publicSession);
});

// ---------------------------------------------------------------------------
// Desktop shortcut ("创建快捷方式") — writes a .lnk that relaunches the app
// with --session=<id>, which auto-connects that session on startup (see
// getLaunchSessionId / the did-finish-load hook in createWindow).
// ---------------------------------------------------------------------------

ipcMain.handle('shortcut:create', (_evt, sessionId) => {
  const session = loadSessions().find((s) => s.id === sessionId);
  if (!session) return { ok: false, error: '会话不存在，可能已被删除。' };

  if (process.platform !== 'win32') {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '暂不支持',
      message: '创建快捷方式目前仅支持 Windows。',
    });
    return { ok: false, error: 'unsupported-platform' };
  }

  const desktop = app.getPath('desktop');
  const safeName = (session.name || session.host || 'session').replace(/[\\/:*?"<>|]/g, '_');
  let shortcutPath = path.join(desktop, `${safeName}.lnk`);
  let n = 2;
  while (fs.existsSync(shortcutPath)) {
    shortcutPath = path.join(desktop, `${safeName} (${n}).lnk`);
    n += 1;
  }

  const target = process.execPath;
  const args = app.isPackaged
    ? `--session=${session.id}`
    : `"${app.getAppPath()}" --session=${session.id}`;

  const ok = shell.writeShortcutLink(shortcutPath, 'create', {
    target,
    args,
    description: `xShell Lite - ${session.name}`,
    cwd: app.isPackaged ? undefined : app.getAppPath(),
  });

  dialog.showMessageBox(mainWindow, {
    type: ok ? 'info' : 'error',
    title: ok ? '已创建快捷方式' : '创建失败',
    message: ok ? `已在桌面创建 “${safeName}.lnk”。` : '创建快捷方式失败，请检查桌面路径权限。',
  });

  return ok ? { ok: true, path: shortcutPath } : { ok: false, error: 'write-failed' };
});

ipcMain.handle('dialog:select-private-key', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择私钥文件',
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------------------------------------------------------------------------
// Host key (fingerprint) verification
// ---------------------------------------------------------------------------

function fingerprintOf(keyBuffer) {
  const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}

async function verifyHostKey(hostId, keyBuffer) {
  const known = loadKnownHosts();
  const fp = fingerprintOf(keyBuffer);
  const entry = known[hostId];

  if (entry && entry.fingerprint === fp) {
    return true; // already trusted, matches
  }

  const detail = entry
    ? `警告：主机 ${hostId} 的密钥指纹已发生变化！\n\n` +
      `已保存的指纹: ${entry.fingerprint}\n` +
      `当前的指纹:   ${fp}\n\n` +
      `这可能意味着服务器被重装，也可能是中间人攻击。是否仍然继续连接？`
    : `无法确认主机 ${hostId} 的真实性。\n\n主机密钥指纹 (SHA256):\n${fp}\n\n是否信任并继续连接？`;

  const res = await dialog.showMessageBox(mainWindow, {
    type: entry ? 'warning' : 'question',
    buttons: ['取消', entry ? '仍然连接' : '信任并连接'],
    defaultId: entry ? 0 : 1,
    cancelId: 0,
    title: entry ? '主机密钥已变更' : '未知主机',
    message: entry ? '主机密钥不匹配' : '新主机确认',
    detail,
  });

  const accepted = res.response === 1;
  if (accepted) {
    known[hostId] = { fingerprint: fp, savedAt: Date.now() };
    saveKnownHosts(known);
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// SSH connections
// ---------------------------------------------------------------------------

const connections = new Map(); // connId -> { client, stream, sftp?, sftpPromise? }

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle('ssh:connect', async (_evt, config) => {
  const connId = randomUUID();
  const hostId = `${config.host}:${config.port || 22}`;

  const client = new Client();

  const connectOpts = {
    host: config.host,
    port: config.port || 22,
    username: config.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    hostVerifier: (keyBuffer, cb) => {
      verifyHostKey(hostId, keyBuffer).then(cb).catch(() => cb(false));
    },
  };

  if (config.authType === 'key' && config.privateKeyPath) {
    try {
      connectOpts.privateKey = fs.readFileSync(config.privateKeyPath);
    } catch (err) {
      return { ok: false, error: `无法读取私钥文件: ${err.message}` };
    }
    if (config.passphrase) connectOpts.passphrase = config.passphrase;
  } else {
    connectOpts.password = config.password || '';
    // Fall back to keyboard-interactive for servers that require it.
    connectOpts.tryKeyboard = true;
  }

  return new Promise((resolve) => {
    let settled = false;

    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => config.password || ''));
    });

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: config.cols || 80, rows: config.rows || 24 }, (err, stream) => {
        if (err) {
          if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
          client.end();
          return;
        }

        connections.set(connId, { client, stream });

        stream.on('data', (data) => {
          sendToRenderer('ssh:data', { id: connId, data: data.toString('utf8') });
        });
        stream.stderr.on('data', (data) => {
          sendToRenderer('ssh:data', { id: connId, data: data.toString('utf8') });
        });
        stream.on('close', () => {
          const conn = connections.get(connId);
          if (conn && conn.sftp) { try { conn.sftp.end(); } catch (_) { /* noop */ } }
          connections.delete(connId);
          sendToRenderer('ssh:closed', { id: connId });
          client.end();
        });

        if (!settled) { settled = true; resolve({ ok: true, id: connId }); }
      });
    });

    client.on('error', (err) => {
      connections.delete(connId);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: err.message });
      } else {
        sendToRenderer('ssh:error', { id: connId, error: err.message });
      }
    });

    client.on('end', () => {
      connections.delete(connId);
      sendToRenderer('ssh:closed', { id: connId });
    });

    try {
      client.connect(connectOpts);
    } catch (err) {
      if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
    }
  });
});

ipcMain.on('ssh:write', (_evt, { id, data }) => {
  const conn = connections.get(id);
  if (conn) conn.stream.write(data);
});

ipcMain.on('ssh:resize', (_evt, { id, cols, rows }) => {
  const conn = connections.get(id);
  if (conn) conn.stream.setWindow(rows, cols, 0, 0);
});

ipcMain.on('ssh:disconnect', (_evt, { id }) => {
  const conn = connections.get(id);
  if (conn) {
    if (conn.sftp) { try { conn.sftp.end(); } catch (_) { /* noop */ } }
    try { conn.stream.end(); } catch (_) { /* noop */ }
    try { conn.client.end(); } catch (_) { /* noop */ }
    connections.delete(id);
  }
});

// ---------------------------------------------------------------------------
// SFTP — file browser backing the "文件传输" panel. Opens one SFTP channel
// per connection, lazily, the first time it's needed.
// ---------------------------------------------------------------------------

function getSftp(connId) {
  const conn = connections.get(connId);
  if (!conn) return Promise.reject(new Error('连接不存在或已断开'));
  if (conn.sftp) return Promise.resolve(conn.sftp);
  if (conn.sftpPromise) return conn.sftpPromise;
  conn.sftpPromise = new Promise((resolve, reject) => {
    conn.client.sftp((err, sftp) => {
      if (err) { conn.sftpPromise = null; reject(err); return; }
      conn.sftp = sftp;
      resolve(sftp);
    });
  });
  return conn.sftpPromise;
}

function sftpErrorMessage(err) {
  return (err && err.message) ? err.message : String(err);
}

// SFTP paths always use '/' regardless of the local OS — that's the protocol's
// own convention, independent of what path.join would do on Windows.
function remoteJoin(dir, name) {
  if (!dir || dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function remoteParent(dir) {
  if (!dir || dir === '/') return '/';
  const trimmed = dir.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

ipcMain.handle('sftp:realpath', async (_evt, connId, remotePath) => {
  try {
    const sftp = await getSftp(connId);
    const resolved = await new Promise((resolve, reject) => {
      sftp.realpath(remotePath || '.', (err, absPath) => (err ? reject(err) : resolve(absPath)));
    });
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('sftp:list', async (_evt, connId, remotePath) => {
  try {
    const sftp = await getSftp(connId);
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)));
    });
    const items = entries
      .map((e) => ({
        name: e.filename,
        isDir: !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()),
        isLink: !!(e.attrs && e.attrs.isSymbolicLink && e.attrs.isSymbolicLink()),
        size: e.attrs ? e.attrs.size : 0,
        mtime: e.attrs && e.attrs.mtime ? e.attrs.mtime * 1000 : null,
      }))
      .filter((e) => e.name !== '.' && e.name !== '..')
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });
    return { ok: true, path: remotePath, items };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('sftp:mkdir', async (_evt, connId, remotePath) => {
  try {
    const sftp = await getSftp(connId);
    await new Promise((resolve, reject) => sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('sftp:delete', async (_evt, connId, remotePath, isDir) => {
  try {
    const sftp = await getSftp(connId);
    await new Promise((resolve, reject) => {
      const cb = (err) => (err ? reject(err) : resolve());
      if (isDir) sftp.rmdir(remotePath, cb);
      else sftp.unlink(remotePath, cb);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('sftp:rename', async (_evt, connId, oldPath, newPath) => {
  try {
    const sftp = await getSftp(connId);
    await new Promise((resolve, reject) => sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('sftp:upload', async (_evt, connId, localPaths, remoteDir) => {
  try {
    const sftp = await getSftp(connId);
    const results = [];
    for (const localPath of localPaths) {
      const name = path.basename(localPath);
      const transferId = randomUUID();
      let stat;
      try {
        stat = fs.statSync(localPath);
      } catch (err) {
        results.push({ name, ok: false, error: sftpErrorMessage(err) });
        continue;
      }
      if (stat.isDirectory()) {
        results.push({ name, ok: false, error: '暂不支持上传整个文件夹' });
        continue;
      }
      const remotePath = remoteJoin(remoteDir, name);
      try {
        await new Promise((resolve, reject) => {
          sftp.fastPut(localPath, remotePath, {
            step: (transferred, _chunk, total) => {
              sendToRenderer('sftp:progress', { connId, transferId, direction: 'upload', name, transferred, total });
            },
          }, (err) => (err ? reject(err) : resolve()));
        });
        sendToRenderer('sftp:progress', { connId, transferId, direction: 'upload', name, done: true });
        results.push({ name, ok: true });
      } catch (err) {
        sendToRenderer('sftp:progress', { connId, transferId, direction: 'upload', name, done: true, error: sftpErrorMessage(err) });
        results.push({ name, ok: false, error: sftpErrorMessage(err) });
      }
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('sftp:download', async (_evt, connId, remoteItems, localDir) => {
  try {
    const sftp = await getSftp(connId);
    const results = [];
    for (const item of remoteItems) {
      const transferId = randomUUID();
      if (item.isDir) {
        results.push({ name: item.name, ok: false, error: '暂不支持下载整个文件夹' });
        continue;
      }
      const localPath = path.join(localDir, item.name);
      try {
        await new Promise((resolve, reject) => {
          sftp.fastGet(item.path, localPath, {
            step: (transferred, _chunk, total) => {
              sendToRenderer('sftp:progress', { connId, transferId, direction: 'download', name: item.name, transferred, total });
            },
          }, (err) => (err ? reject(err) : resolve()));
        });
        sendToRenderer('sftp:progress', { connId, transferId, direction: 'download', name: item.name, done: true });
        results.push({ name: item.name, ok: true, localPath });
      } catch (err) {
        sendToRenderer('sftp:progress', { connId, transferId, direction: 'download', name: item.name, done: true, error: sftpErrorMessage(err) });
        results.push({ name: item.name, ok: false, error: sftpErrorMessage(err) });
      }
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: sftpErrorMessage(err) };
  }
});

ipcMain.handle('dialog:select-upload-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择要上传的文件',
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('dialog:select-download-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
