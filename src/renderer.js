'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessions = [];           // saved session metadata (no secrets)
let folders = [];            // folder (group) names, created independently of sessions
let editingSessionId = null; // session currently open in the modal (null = new)
let currentAuthType = 'password';
let selectedSessionId = null; // single-click selection in the sidebar (double-click connects)
let searchQuery = '';        // sidebar search box: matches session name or host/IP

const tabs = new Map(); // connId -> { session, term, fitAddon, paneEl, tabEl, status }
let activeTabId = null;

// sessionId -> { connecting: number, connected: number } — drives the sidebar status dot.
// Counts (not booleans) because the same session can have more than one open tab.
const sessionStatus = new Map();
const collapsedGroups = new Set(); // group names currently collapsed in the sidebar

let sftpPanelOpen = false;
let sftpContextItem = null; // { name, path, isDir } for the SFTP row context menu
const sftpTransferEls = new Map(); // transferId -> DOM element in the transfers list

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const el = {
  sessionList: document.getElementById('session-list'),
  tabBar: document.getElementById('tab-bar-tabs'),
  terminalArea: document.getElementById('terminal-area'),
  emptyState: document.getElementById('empty-state'),
  modalOverlay: document.getElementById('modal-overlay'),
  modalTitle: document.getElementById('modal-title'),
  form: document.getElementById('session-form'),
  fId: document.getElementById('f-id'),
  fName: document.getElementById('f-name'),
  fFolder: document.getElementById('f-folder'),
  fHost: document.getElementById('f-host'),
  fPort: document.getElementById('f-port'),
  fUsername: document.getElementById('f-username'),
  fPassword: document.getElementById('f-password'),
  fKeypath: document.getElementById('f-keypath'),
  fPassphrase: document.getElementById('f-passphrase'),
  authPassword: document.getElementById('auth-password'),
  authKey: document.getElementById('auth-key'),
  btnDeleteSession: document.getElementById('btn-delete-session'),
  btnNewMenu: document.getElementById('btn-new-menu'),
  newMenu: document.getElementById('new-menu'),
  menuNewSession: document.getElementById('menu-new-session'),
  menuNewFolder: document.getElementById('menu-new-folder'),
  folderModalOverlay: document.getElementById('folder-modal-overlay'),
  folderForm: document.getElementById('folder-form'),
  fFolderName: document.getElementById('f-folder-name'),
  btnFolderCancel: document.getElementById('btn-folder-cancel'),
  sessionContextMenu: document.getElementById('session-context-menu'),
  searchInput: document.getElementById('search-input'),
  sidebarContextMenu: document.getElementById('sidebar-context-menu'),
  ctxNewParent: document.getElementById('ctx-new-parent'),
  ctxNewSubmenu: document.getElementById('ctx-new-submenu'),
  ctxNewSession: document.getElementById('ctx-new-session'),
  ctxNewFolder: document.getElementById('ctx-new-folder'),
  folderContextMenu: document.getElementById('folder-context-menu'),
  btnToggleSftp: document.getElementById('btn-toggle-sftp'),
  sftpPanel: document.getElementById('sftp-panel'),
  sftpPath: document.getElementById('sftp-path'),
  sftpUp: document.getElementById('sftp-up'),
  sftpGo: document.getElementById('sftp-go'),
  sftpRefresh: document.getElementById('sftp-refresh'),
  sftpMkdir: document.getElementById('sftp-mkdir'),
  sftpUpload: document.getElementById('sftp-upload'),
  sftpClose: document.getElementById('sftp-close'),
  sftpBody: document.getElementById('sftp-body'),
  sftpMessage: document.getElementById('sftp-message'),
  sftpTable: document.getElementById('sftp-table'),
  sftpList: document.getElementById('sftp-list'),
  sftpDropzone: document.getElementById('sftp-dropzone'),
  sftpTransfers: document.getElementById('sftp-transfers'),
  sftpContextMenu: document.getElementById('sftp-context-menu'),
};

// ---------------------------------------------------------------------------
// Session list rendering
// ---------------------------------------------------------------------------

function sessionStatusClass(sessionId) {
  const st = sessionStatus.get(sessionId);
  if (!st) return 'idle';
  if (st.connected > 0) return 'connected';
  if (st.connecting > 0) return 'connecting';
  return 'idle';
}

function setSessionStatus(sessionId, field, delta) {
  if (!sessionId) return;
  const st = sessionStatus.get(sessionId) || { connecting: 0, connected: 0 };
  st[field] = Math.max(0, st[field] + delta);
  sessionStatus.set(sessionId, st);

  const dot = el.sessionList.querySelector(`.session-item[data-session-id="${sessionId}"] .dot`);
  if (dot) {
    dot.classList.remove('status-idle', 'status-connecting', 'status-connected');
    dot.classList.add(`status-${sessionStatusClass(sessionId)}`);
  }
}

function selectSession(id) {
  selectedSessionId = id;
  el.sessionList.querySelectorAll('.session-item').forEach((li) => {
    li.classList.toggle('selected', li.dataset.sessionId === id);
  });
}

function groupSessions(list) {
  const byGroup = new Map(); // folder name -> sessions[]
  for (const f of folders) byGroup.set(f, []); // seed so empty folders still show a header
  const ungrouped = [];
  for (const s of list) {
    const g = (s.group || '').trim();
    if (!g) { ungrouped.push(s); continue; }
    if (!byGroup.has(g)) byGroup.set(g, []); // legacy/orphaned group value not in the folder list
    byGroup.get(g).push(s);
  }
  const names = [...byGroup.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
  const order = names.map((name) => ({ name, items: byGroup.get(name) }));
  order.push({ name: '', items: ungrouped });
  return order;
}

function populateFolderSelect() {
  const current = el.fFolder.value;
  el.fFolder.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '无（不分组）';
  el.fFolder.appendChild(noneOpt);
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    el.fFolder.appendChild(opt);
  }
  if (folders.includes(current)) el.fFolder.value = current;
}

async function refreshSessionList() {
  [sessions, folders] = await Promise.all([window.api.sessions.list(), window.api.folders.list()]);
  el.sessionList.innerHTML = '';
  populateFolderSelect();

  if (sessions.length === 0 && folders.length === 0) {
    const li = document.createElement('li');
    li.className = 'session-empty';
    li.textContent = '还没有保存的会话，点击右上角 “＋” 新建一个。';
    el.sessionList.appendChild(li);
    return;
  }

  const q = searchQuery.trim().toLowerCase();
  const searching = q.length > 0;
  const visibleSessions = searching
    ? sessions.filter((s) => (s.name || '').toLowerCase().includes(q) || (s.host || '').toLowerCase().includes(q))
    : sessions;

  if (searching && visibleSessions.length === 0) {
    const li = document.createElement('li');
    li.className = 'session-empty';
    li.textContent = '没有匹配的会话';
    el.sessionList.appendChild(li);
    return;
  }

  const groups = groupSessions(visibleSessions);
  const showHeaders = folders.length > 0 || groups.some((g) => g.name !== '');

  for (const { name, items } of groups) {
    // While searching, skip empty buckets and always show matches (ignore collapse state).
    if (searching && items.length === 0) continue;
    if (showHeaders) {
      const collapsed = !searching && collapsedGroups.has(name);
      const header = document.createElement('li');
      header.className = 'group-header';
      header.dataset.group = name;
      header.innerHTML = `
        <span class="chevron">${collapsed ? '▸' : '▾'}</span>
        <span class="group-name"></span>
        <span class="group-count"></span>
      `;
      header.querySelector('.group-name').textContent = name || '未分组';
      header.querySelector('.group-count').textContent = items.length;
      header.addEventListener('click', () => {
        if (collapsedGroups.has(name)) collapsedGroups.delete(name);
        else collapsedGroups.add(name);
        refreshSessionList();
      });
      header.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        header.classList.add('drag-over');
      });
      header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
      header.addEventListener('drop', async (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const sessionId = e.dataTransfer.getData('text/plain');
        await moveSessionToFolder(sessionId, name);
      });
      if (name !== '') { // "未分组" is a virtual bucket, not a real folder — no rename/delete on it
        header.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openFolderContextMenu(name, e.clientX, e.clientY);
        });
      }
      el.sessionList.appendChild(header);
      if (collapsed) continue;
    }

    for (const s of items) {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.dataset.sessionId = s.id;
      li.draggable = true;
      if (s.id === selectedSessionId) li.classList.add('selected');
      li.innerHTML = `
        <span class="dot status-${sessionStatusClass(s.id)}"></span>
        <span class="info">
          <div class="name"></div>
          <div class="meta"></div>
        </span>
        <button class="edit-btn" title="编辑">✎</button>
      `;
      li.querySelector('.name').textContent = s.name;
      li.querySelector('.meta').textContent = `${s.username}@${s.host}:${s.port}`;

      li.addEventListener('click', (e) => {
        if (e.target.closest('.edit-btn')) return;
        selectSession(s.id);
      });
      li.addEventListener('dblclick', (e) => {
        if (e.target.closest('.edit-btn')) return;
        connectSession(s);
      });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectSession(s.id);
        openSessionContextMenu(s.id, e.clientX, e.clientY);
      });
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', s.id);
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(s);
      });

      el.sessionList.appendChild(li);
    }
  }
}

async function moveSessionToFolder(sessionId, folderName) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const group = (folderName || '').trim();
  if ((s.group || '') === group) return; // already there
  await window.api.sessions.save({
    id: s.id,
    name: s.name,
    group,
    host: s.host,
    port: s.port,
    username: s.username,
    authType: s.authType,
    privateKeyPath: s.privateKeyPath,
  });
  await refreshSessionList();
}

// ---------------------------------------------------------------------------
// Modal (new / edit session)
// ---------------------------------------------------------------------------

function setAuthType(type) {
  currentAuthType = type;
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.auth === type);
  });
  el.authPassword.classList.toggle('hidden', type !== 'password');
  el.authKey.classList.toggle('hidden', type !== 'key');
}

async function openModal(session) {
  el.form.reset();
  setAuthType('password');

  if (session) {
    editingSessionId = session.id;
    el.modalTitle.textContent = '编辑会话';
    el.fId.value = session.id;
    el.fName.value = session.name;
    el.fFolder.value = session.group || '';
    el.fHost.value = session.host;
    el.fPort.value = session.port;
    el.fUsername.value = session.username;
    el.fKeypath.value = session.privateKeyPath || '';
    setAuthType(session.authType || 'password');
    el.btnDeleteSession.classList.remove('hidden');

    // Pre-fill secrets so re-saving without retyping doesn't clear them.
    const secrets = await window.api.sessions.getSecrets(session.id);
    if (secrets) {
      el.fPassword.value = secrets.password || '';
      el.fPassphrase.value = secrets.passphrase || '';
    }
  } else {
    editingSessionId = null;
    el.modalTitle.textContent = '新建会话';
    el.fId.value = '';
    el.fPort.value = 22;
    el.btnDeleteSession.classList.add('hidden');
  }

  el.modalOverlay.classList.remove('hidden');
  el.fName.focus();
}

function closeModal() {
  el.modalOverlay.classList.add('hidden');
  editingSessionId = null;
}

document.getElementById('btn-empty-new-session').addEventListener('click', () => openModal(null));
document.getElementById('btn-cancel').addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', (e) => {
  if (e.target === el.modalOverlay) closeModal();
});

// ---------------------------------------------------------------------------
// "新建" menu: 会话 / 文件夹 — opened from the "+" button (anchored under it)
// or from a right-click on empty sidebar space (anchored at the cursor).
// ---------------------------------------------------------------------------

function showNewMenu(x, y, alignRight) {
  closeSessionContextMenu();
  closeSidebarContextMenu();
  closeFolderContextMenu();
  const menu = el.newMenu;
  menu.classList.remove('hidden');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  // Measure after it's actually visible — offsetWidth/getBoundingClientRect
  // are unreliable while display:none.
  let rect = menu.getBoundingClientRect();
  if (alignRight) {
    menu.style.left = `${Math.max(0, x - rect.width)}px`;
    rect = menu.getBoundingClientRect();
  }
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

function hideNewMenu() {
  el.newMenu.classList.add('hidden');
}

el.btnNewMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!el.newMenu.classList.contains('hidden')) { hideNewMenu(); return; }
  const rect = el.btnNewMenu.getBoundingClientRect();
  showNewMenu(rect.right, rect.bottom + 4, true);
});
document.addEventListener('click', (e) => {
  if (!el.newMenu.classList.contains('hidden') && !e.target.closest('.new-menu-wrap')) {
    hideNewMenu();
  }
});
el.menuNewSession.addEventListener('click', () => {
  hideNewMenu();
  openModal(null);
});
el.menuNewFolder.addEventListener('click', () => {
  hideNewMenu();
  openFolderModal();
});

// ---------------------------------------------------------------------------
// Right-click on empty sidebar space: 新建 ▸ 会话 / 文件夹 (cascading submenu,
// like Explorer's "New" menu) — distinct from the "+" button's flat menu.
// ---------------------------------------------------------------------------

function openSidebarContextMenu(x, y) {
  hideNewMenu();
  closeSessionContextMenu();
  closeFolderContextMenu();
  const menu = el.sidebarContextMenu;
  menu.classList.remove('hidden');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

function closeSidebarContextMenu() {
  el.sidebarContextMenu.classList.add('hidden');
  el.ctxNewSubmenu.classList.add('hidden');
  el.ctxNewParent.classList.remove('active');
}

function openCtxNewSubmenu() {
  el.ctxNewParent.classList.add('active');
  const submenu = el.ctxNewSubmenu;
  submenu.classList.remove('hidden');
  const rect = el.ctxNewParent.getBoundingClientRect();
  submenu.style.left = `${rect.right + 2}px`;
  submenu.style.top = `${rect.top}px`;
  const sr = submenu.getBoundingClientRect();
  if (sr.right > window.innerWidth) submenu.style.left = `${Math.max(0, rect.left - sr.width - 2)}px`;
  if (sr.bottom > window.innerHeight) submenu.style.top = `${Math.max(0, window.innerHeight - sr.height - 4)}px`;
}

el.sessionList.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.session-item') || e.target.closest('.group-header')) return;
  e.preventDefault();
  openSidebarContextMenu(e.clientX, e.clientY);
});

el.ctxNewParent.addEventListener('mouseenter', openCtxNewSubmenu);
el.ctxNewParent.addEventListener('click', openCtxNewSubmenu);

el.ctxNewSession.addEventListener('click', () => {
  closeSidebarContextMenu();
  openModal(null);
});
el.ctxNewFolder.addEventListener('click', () => {
  closeSidebarContextMenu();
  openFolderModal();
});

document.addEventListener('click', (e) => {
  if (el.sidebarContextMenu.classList.contains('hidden')) return;
  if (e.target.closest('#sidebar-context-menu') || e.target.closest('#ctx-new-submenu')) return;
  closeSidebarContextMenu();
});

// ---------------------------------------------------------------------------
// Sidebar search: filters by session name or host/IP as you type
// ---------------------------------------------------------------------------

let searchDebounce = null;
el.searchInput.addEventListener('input', () => {
  searchQuery = el.searchInput.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => refreshSessionList(), 120);
});

function openFolderModal() {
  el.folderForm.reset();
  el.folderModalOverlay.classList.remove('hidden');
  el.fFolderName.focus();
}

function closeFolderModal() {
  el.folderModalOverlay.classList.add('hidden');
}

el.btnFolderCancel.addEventListener('click', closeFolderModal);
el.folderModalOverlay.addEventListener('click', (e) => {
  if (e.target === el.folderModalOverlay) closeFolderModal();
});

el.folderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.fFolderName.value.trim();
  if (!name) return;
  folders = await window.api.folders.create(name);
  closeFolderModal();
  await refreshSessionList();
});

document.querySelectorAll('.auth-tab').forEach((btn) => {
  btn.addEventListener('click', () => setAuthType(btn.dataset.auth));
});

document.getElementById('btn-browse-key').addEventListener('click', async () => {
  const p = await window.api.dialog.selectPrivateKey();
  if (p) el.fKeypath.value = p;
});

async function deleteSessionById(id) {
  if (!confirm('确定要删除这个会话吗？')) return;
  await window.api.sessions.delete(id);
  await refreshSessionList();
}

el.btnDeleteSession.addEventListener('click', async () => {
  if (!editingSessionId) return;
  await deleteSessionById(editingSessionId);
  closeModal();
});

// ---------------------------------------------------------------------------
// Session right-click context menu: 打开 / 重命名 / 删除 / 创建桌面快捷方式
// ---------------------------------------------------------------------------

let contextMenuSessionId = null;

function openSessionContextMenu(id, x, y) {
  hideNewMenu();
  closeSidebarContextMenu();
  closeFolderContextMenu();
  contextMenuSessionId = id;
  const menu = el.sessionContextMenu;
  menu.classList.remove('hidden');
  // Position first, then clamp to the viewport so it doesn't overflow.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

function closeSessionContextMenu() {
  contextMenuSessionId = null;
  el.sessionContextMenu.classList.add('hidden');
}

document.addEventListener('click', () => closeSessionContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.session-item')) closeSessionContextMenu();
});
window.addEventListener('blur', () => closeSessionContextMenu());

el.sessionContextMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.stopPropagation();
  const id = contextMenuSessionId;
  closeSessionContextMenu();
  if (!id) return;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;

  switch (btn.dataset.action) {
    case 'open':
      connectSession(s);
      break;
    case 'rename':
      startRenameSession(id);
      break;
    case 'delete':
      await deleteSessionById(id);
      break;
    case 'shortcut':
      await window.api.shortcut.create(id);
      break;
  }
});

function startRenameSession(id) {
  const li = el.sessionList.querySelector(`.session-item[data-session-id="${id}"]`);
  const s = sessions.find((x) => x.id === id);
  const nameEl = li && li.querySelector('.name');
  if (!li || !s || !nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = s.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== s.name) {
      await window.api.sessions.save({
        id: s.id,
        name: newName,
        group: s.group,
        host: s.host,
        port: s.port,
        username: s.username,
        authType: s.authType,
        privateKeyPath: s.privateKeyPath,
      });
      await refreshSessionList();
    } else {
      input.replaceWith(nameEl);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// Folder right-click context menu: 重命名 / 删除
// ---------------------------------------------------------------------------

let contextMenuFolderName = null;

function findGroupHeaderEl(name) {
  return [...el.sessionList.querySelectorAll('.group-header')].find((h) => h.dataset.group === name);
}

function openFolderContextMenu(name, x, y) {
  hideNewMenu();
  closeSessionContextMenu();
  closeSidebarContextMenu();
  contextMenuFolderName = name;
  const menu = el.folderContextMenu;
  menu.classList.remove('hidden');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

function closeFolderContextMenu() {
  contextMenuFolderName = null;
  el.folderContextMenu.classList.add('hidden');
}

document.addEventListener('click', () => closeFolderContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.group-header')) closeFolderContextMenu();
});
window.addEventListener('blur', () => closeFolderContextMenu());

el.folderContextMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.stopPropagation();
  const name = contextMenuFolderName;
  closeFolderContextMenu();
  if (name === null) return;

  switch (btn.dataset.action) {
    case 'rename':
      startRenameFolder(name);
      break;
    case 'delete':
      await deleteFolder(name);
      break;
  }
});

function startRenameFolder(name) {
  const header = findGroupHeaderEl(name);
  const nameEl = header && header.querySelector('.group-name');
  if (!header || !nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== name) {
      await window.api.folders.rename(name, newName);
      await refreshSessionList();
    } else {
      input.replaceWith(nameEl);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

async function deleteFolder(name) {
  const count = sessions.filter((s) => (s.group || '').trim() === name).length;
  const msg = count > 0
    ? `确定要删除文件夹"${name}"吗？其中的 ${count} 个会话会移动到"未分组"。`
    : `确定要删除文件夹"${name}"吗？`;
  if (!confirm(msg)) return;
  await window.api.folders.delete(name);
  await refreshSessionList();
}

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const payload = {
    id: el.fId.value || undefined,
    name: el.fName.value.trim() || el.fHost.value.trim(),
    group: el.fFolder.value.trim(),
    host: el.fHost.value.trim(),
    port: parseInt(el.fPort.value, 10) || 22,
    username: el.fUsername.value.trim(),
    authType: currentAuthType,
    password: currentAuthType === 'password' ? el.fPassword.value : '',
    privateKeyPath: currentAuthType === 'key' ? el.fKeypath.value : '',
    passphrase: currentAuthType === 'key' ? el.fPassphrase.value : '',
  };

  const updated = await window.api.sessions.save(payload);
  sessions = updated;
  closeModal();
  await refreshSessionList();

  // Connect immediately using the just-saved session (with secrets in hand,
  // no need to round-trip through storage/decrypt).
  const saved = sessions.find((s) => s.host === payload.host && s.username === payload.username && s.port === payload.port) || sessions[sessions.length - 1];
  connectSession(saved, { password: payload.password, passphrase: payload.passphrase, privateKeyPath: payload.privateKeyPath, authType: payload.authType });
});

// ---------------------------------------------------------------------------
// Tabs / terminals
// ---------------------------------------------------------------------------

function makeTabId() {
  return 'pending-' + Math.random().toString(36).slice(2);
}

async function connectSession(session, overrideSecrets) {
  const tempId = makeTabId();
  const tab = createTabShell(tempId, session.name);
  tab.sessionId = session.id;
  switchToTab(tempId);
  selectSession(session.id);
  setSessionStatus(session.id, 'connecting', 1);
  tab.term.writeln(`\x1b[90m正在连接 ${session.username}@${session.host}:${session.port} ...\x1b[0m`);

  let secrets = overrideSecrets;
  if (!secrets) {
    secrets = await window.api.sessions.getSecrets(session.id);
  }

  const config = {
    host: session.host,
    port: session.port,
    username: session.username,
    authType: overrideSecrets ? overrideSecrets.authType : session.authType,
    password: secrets ? secrets.password : '',
    privateKeyPath: (overrideSecrets ? overrideSecrets.privateKeyPath : session.privateKeyPath) || '',
    passphrase: secrets ? secrets.passphrase : '',
    cols: tab.term.cols,
    rows: tab.term.rows,
  };

  const result = await window.api.ssh.connect(config);

  if (!result.ok) {
    setSessionStatus(session.id, 'connecting', -1);
    tab.term.writeln(`\x1b[31m连接失败: ${result.error}\x1b[0m`);
    setTabStatus(tempId, 'error');
    return;
  }

  // Re-key the tab from the temporary id to the real connection id.
  rekeyTab(tempId, result.id, session);
  setTabStatus(result.id, 'connected');
  setSessionStatus(session.id, 'connecting', -1);
  setSessionStatus(session.id, 'connected', 1);
  tab.term.writeln('\x1b[32m已连接。\x1b[0m\r\n');
  tab.term.focus();

  window.api.ssh.write(result.id, ''); // no-op, ensures channel primed
}

function createTabShell(id, title) {
  const tabEl = document.createElement('div');
  tabEl.className = 'tab status-connecting';
  tabEl.dataset.id = id;
  tabEl.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-title"></span>
    <button class="tab-close" title="关闭">×</button>
  `;
  tabEl.querySelector('.tab-title').textContent = title;
  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) return;
    switchToTab(id);
  });
  tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  el.tabBar.appendChild(tabEl);

  const paneEl = document.createElement('div');
  paneEl.className = 'term-pane';
  paneEl.dataset.id = id;
  el.terminalArea.appendChild(paneEl);

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Consolas", "Menlo", monospace',
    fontSize: 14,
    theme: {
      background: '#0c0c0c',
      foreground: '#d7d9dc',
      cursor: '#3ecf8e',
    },
    cursorBlink: true,
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(paneEl);

  const tab = { id, session: null, term, fitAddon, paneEl, tabEl, status: 'connecting', connected: false, sftpPath: null };

  term.onData((data) => {
    if (tab.connected) window.api.ssh.write(tab.id, data);
  });

  tabs.set(id, tab);

  el.emptyState.style.display = 'none';

  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch (_) { /* pane may not be visible yet */ }
  });

  return tab;
}

function rekeyTab(oldId, newId, session) {
  const tab = tabs.get(oldId);
  if (!tab) return;
  tabs.delete(oldId);
  tab.id = newId;
  tab.session = session;
  tab.connected = true;
  tab.tabEl.dataset.id = newId;
  tab.paneEl.dataset.id = newId;
  tabs.set(newId, tab);
  if (activeTabId === oldId) activeTabId = newId;

  tab.tabEl.querySelector('.tab-close').onclick = (e) => {
    e.stopPropagation();
    closeTab(newId);
  };
  tab.tabEl.onclick = (e) => {
    if (e.target.closest('.tab-close')) return;
    switchToTab(newId);
  };

  fitActiveTab();
  updateSftpToggleAvailability();
  if (sftpPanelOpen && activeTabId === newId) loadSftpForActiveTab();
}

function setTabStatus(id, status) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.status = status;
  tab.tabEl.classList.remove('status-connecting', 'status-error', 'status-connected');
  tab.tabEl.classList.add(`status-${status}`);
}

function switchToTab(id) {
  activeTabId = id;
  for (const [tid, t] of tabs) {
    const isActive = tid === id;
    t.tabEl.classList.toggle('active', isActive);
    t.paneEl.classList.toggle('active', isActive);
  }
  fitActiveTab();
  updateSftpToggleAvailability();
  if (sftpPanelOpen) loadSftpForActiveTab();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.connected) {
    window.api.ssh.disconnect(id);
    setSessionStatus(tab.sessionId, 'connected', -1);
  }
  tab.term.dispose();
  tab.tabEl.remove();
  tab.paneEl.remove();
  tabs.delete(id);

  if (activeTabId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length) switchToTab(remaining[remaining.length - 1]);
    else {
      activeTabId = null;
      el.emptyState.style.display = 'flex';
      updateSftpToggleAvailability();
    }
  }
}

function fitActiveTab() {
  if (!activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  try {
    tab.fitAddon.fit();
    if (tab.connected) {
      window.api.ssh.resize(activeTabId, tab.term.cols, tab.term.rows);
    }
  } catch (_) { /* ignore transient layout errors */ }
}

window.addEventListener('resize', () => {
  fitActiveTab();
});

// ---------------------------------------------------------------------------
// SSH stream events from main process
// ---------------------------------------------------------------------------

window.api.ssh.onData(({ id, data }) => {
  const tab = tabs.get(id);
  if (tab) tab.term.write(data);
});

window.api.ssh.onClosed(({ id }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.connected) setSessionStatus(tab.sessionId, 'connected', -1);
  tab.connected = false;
  setTabStatus(id, 'error');
  tab.term.writeln('\r\n\x1b[90m[连接已断开]\x1b[0m');
  if (id === activeTabId) updateSftpToggleAvailability();
});

window.api.ssh.onError(({ id, error }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.term.writeln(`\r\n\x1b[31m[错误] ${error}\x1b[0m`);
});

// ---------------------------------------------------------------------------
// SFTP file browser panel — bound to whichever tab is active. One SFTP
// channel per connection is opened lazily on the main-process side the first
// time this panel is used for that tab.
// ---------------------------------------------------------------------------

function remoteJoin(dir, name) {
  if (!dir || dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function remoteParent(dir) {
  if (!dir || dir === '/') return '/';
  const trimmed = dir.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateSftpToggleAvailability() {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  const available = !!(tab && tab.connected);
  el.btnToggleSftp.disabled = !available;
  el.btnToggleSftp.classList.toggle('active', sftpPanelOpen);
  if (!available && sftpPanelOpen) closeSftpPanel();
}

function toggleSftpPanel() {
  if (el.btnToggleSftp.disabled) return;
  if (sftpPanelOpen) closeSftpPanel();
  else openSftpPanel();
}

function openSftpPanel() {
  sftpPanelOpen = true;
  el.sftpPanel.classList.remove('hidden');
  el.btnToggleSftp.classList.add('active');
  loadSftpForActiveTab();
  fitActiveTab();
}

function closeSftpPanel() {
  sftpPanelOpen = false;
  el.sftpPanel.classList.add('hidden');
  el.btnToggleSftp.classList.remove('active');
  fitActiveTab();
}

el.btnToggleSftp.addEventListener('click', toggleSftpPanel);
el.sftpClose.addEventListener('click', closeSftpPanel);

function showSftpMessage(text, isError) {
  el.sftpMessage.textContent = text;
  el.sftpMessage.classList.remove('hidden');
  el.sftpMessage.classList.toggle('error', !!isError);
  el.sftpTable.classList.add('hidden');
}

function hideSftpMessage() {
  el.sftpMessage.classList.add('hidden');
  el.sftpTable.classList.remove('hidden');
}

async function loadSftpForActiveTab() {
  const tab = tabs.get(activeTabId);
  if (!tab || !tab.connected) return;
  if (tab.sftpPath == null) {
    showSftpMessage('加载中…');
    const res = await window.api.sftp.realpath(tab.id, '.');
    if (tab.id !== activeTabId) return; // switched away while awaiting
    tab.sftpPath = res.ok ? res.path : '/';
  }
  await loadSftpDir(activeTabId, tab.sftpPath);
}

async function loadSftpDir(connId, dirPath) {
  const tab = tabs.get(connId);
  if (!tab) return;
  showSftpMessage('加载中…');
  const res = await window.api.sftp.list(connId, dirPath);
  if (connId !== activeTabId) return; // user switched tabs while this was in flight
  if (!res.ok) {
    showSftpMessage(`加载失败：${res.error}`, true);
    return;
  }
  tab.sftpPath = res.path;
  el.sftpPath.value = res.path;
  hideSftpMessage();
  renderSftpList(connId, res.path, res.items);
}

function renderSftpList(connId, dirPath, items) {
  el.sftpList.innerHTML = '';
  if (items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.style.cssText = 'color:var(--text-dim); text-align:center; padding:16px;';
    td.textContent = '空文件夹';
    tr.appendChild(td);
    el.sftpList.appendChild(tr);
    return;
  }

  for (const item of items) {
    const remotePath = remoteJoin(dirPath, item.name);
    const tr = document.createElement('tr');
    tr.dataset.name = item.name;
    tr.innerHTML = `
      <td class="col-name"><span class="file-icon">${item.isDir ? '📁' : '📄'}</span><span class="name-text"></span></td>
      <td class="col-size"></td>
      <td class="col-mtime"></td>
    `;
    tr.querySelector('.name-text').textContent = item.name;
    tr.querySelector('.col-size').textContent = item.isDir ? '' : formatBytes(item.size);
    tr.querySelector('.col-mtime').textContent = item.mtime ? formatDateTime(item.mtime) : '';

    tr.addEventListener('dblclick', () => {
      if (item.isDir) loadSftpDir(connId, remotePath);
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSftpContextMenu({ name: item.name, path: remotePath, isDir: item.isDir }, e.clientX, e.clientY);
    });

    el.sftpList.appendChild(tr);
  }
}

el.sftpUp.addEventListener('click', () => {
  const tab = tabs.get(activeTabId);
  if (tab) loadSftpDir(activeTabId, remoteParent(tab.sftpPath));
});

function navigateToTypedSftpPath() {
  const p = el.sftpPath.value.trim();
  if (p) loadSftpDir(activeTabId, p);
}
el.sftpGo.addEventListener('click', navigateToTypedSftpPath);
el.sftpPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigateToTypedSftpPath();
});

el.sftpRefresh.addEventListener('click', () => {
  const tab = tabs.get(activeTabId);
  if (tab) loadSftpDir(activeTabId, tab.sftpPath);
});

// ---- New folder (inline editable row, same pattern as session/folder rename) ----

el.sftpMkdir.addEventListener('click', () => {
  const tab = tabs.get(activeTabId);
  if (tab) startSftpMkdirRow(tab);
});

function startSftpMkdirRow(tab) {
  const tr = document.createElement('tr');
  const nameTd = document.createElement('td');
  nameTd.className = 'col-name';
  nameTd.innerHTML = '<span class="file-icon">📁</span>';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.placeholder = '新文件夹名称';
  nameTd.appendChild(input);
  tr.appendChild(nameTd);
  tr.appendChild(document.createElement('td'));
  tr.appendChild(document.createElement('td'));
  el.sftpList.insertBefore(tr, el.sftpList.firstChild);
  input.focus();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name) {
      const res = await window.api.sftp.mkdir(activeTabId, remoteJoin(tab.sftpPath, name));
      if (!res.ok) alert(`创建文件夹失败：${res.error}`);
      loadSftpDir(activeTabId, tab.sftpPath);
    } else {
      tr.remove();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ---- Upload (toolbar button + drag-and-drop from the OS) ----

el.sftpUpload.addEventListener('click', async () => {
  const files = await window.api.dialog.selectUploadFiles();
  if (files && files.length) await uploadFilesToCurrentDir(files);
});

async function uploadFilesToCurrentDir(localPaths) {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const connId = activeTabId;
  const res = await window.api.sftp.upload(connId, localPaths, tab.sftpPath);
  if (connId === activeTabId) loadSftpDir(connId, tab.sftpPath);
  const failed = res.ok ? (res.results || []).filter((r) => !r.ok) : [];
  if (!res.ok) alert(`上传失败：${res.error}`);
  else if (failed.length) alert(`部分文件上传失败：\n${failed.map((f) => `${f.name}: ${f.error}`).join('\n')}`);
}

el.sftpBody.addEventListener('dragover', (e) => {
  if (!sftpPanelOpen) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  el.sftpDropzone.classList.remove('hidden');
});
el.sftpBody.addEventListener('dragleave', (e) => {
  if (!el.sftpBody.contains(e.relatedTarget)) el.sftpDropzone.classList.add('hidden');
});
el.sftpBody.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.sftpDropzone.classList.add('hidden');
  const files = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
  if (files.length) await uploadFilesToCurrentDir(files);
});

// ---- Row context menu: 下载 / 重命名 / 删除 ----

function openSftpContextMenu(item, x, y) {
  hideNewMenu();
  closeSessionContextMenu();
  closeSidebarContextMenu();
  closeFolderContextMenu();
  sftpContextItem = item;
  const menu = el.sftpContextMenu;
  menu.classList.remove('hidden');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

function closeSftpContextMenu() {
  sftpContextItem = null;
  el.sftpContextMenu.classList.add('hidden');
}

document.addEventListener('click', () => closeSftpContextMenu());
window.addEventListener('blur', () => closeSftpContextMenu());

el.sftpContextMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.stopPropagation();
  const item = sftpContextItem;
  closeSftpContextMenu();
  if (!item) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;

  switch (btn.dataset.action) {
    case 'download': {
      if (item.isDir) { alert('暂不支持下载整个文件夹，请下载里面的单个文件。'); break; }
      const dir = await window.api.dialog.selectDownloadDir();
      if (!dir) break;
      const res = await window.api.sftp.download(activeTabId, [item], dir);
      const failed = res.ok ? (res.results || []).filter((r) => !r.ok) : [];
      if (!res.ok) alert(`下载失败：${res.error}`);
      else if (failed.length) alert(`下载失败：${failed[0].error}`);
      break;
    }
    case 'rename':
      startRenameSftpItem(tab, item);
      break;
    case 'delete': {
      const kind = item.isDir ? '文件夹' : '文件';
      if (!confirm(`确定要删除${kind} "${item.name}" 吗？${item.isDir ? '（文件夹必须为空才能删除）' : ''}`)) break;
      const res = await window.api.sftp.delete(activeTabId, item.path, item.isDir);
      if (!res.ok) { alert(`删除失败：${res.error}`); break; }
      loadSftpDir(activeTabId, tab.sftpPath);
      break;
    }
  }
});

function startRenameSftpItem(tab, item) {
  const tr = [...el.sftpList.querySelectorAll('tr')].find((r) => r.dataset.name === item.name);
  const nameText = tr && tr.querySelector('.name-text');
  if (!tr || !nameText) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = item.name;
  nameText.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== item.name) {
      const newPath = remoteJoin(tab.sftpPath, newName);
      const res = await window.api.sftp.rename(activeTabId, item.path, newPath);
      if (!res.ok) alert(`重命名失败：${res.error}`);
      loadSftpDir(activeTabId, tab.sftpPath);
    } else {
      input.replaceWith(nameText);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---- Transfer progress ----

window.api.sftp.onProgress((payload) => {
  const { transferId, name, direction, transferred, total, done, error } = payload;
  let row = sftpTransferEls.get(transferId);
  if (!row) {
    row = document.createElement('div');
    row.className = 'sftp-transfer';
    row.innerHTML = `<div class="row"><span class="name"></span><span class="pct"></span></div><div class="bar"><div class="bar-fill"></div></div>`;
    row.querySelector('.name').textContent = `${direction === 'upload' ? '⬆' : '⬇'} ${name}`;
    el.sftpTransfers.appendChild(row);
    sftpTransferEls.set(transferId, row);
  }
  const pct = total ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  if (!done) {
    row.querySelector('.bar-fill').style.width = `${pct}%`;
    row.querySelector('.pct').textContent = `${pct}%`;
  } else {
    row.classList.add(error ? 'error' : 'done');
    row.querySelector('.bar-fill').style.width = '100%';
    row.querySelector('.pct').textContent = error ? '失败' : '完成';
    sftpTransferEls.delete(transferId);
    setTimeout(() => row.remove(), 4000);
  }
});

// ---------------------------------------------------------------------------
// Menu bridge
// ---------------------------------------------------------------------------

window.api.menu.onNewSession(() => openModal(null));
window.api.menu.onCloseTab(() => {
  if (activeTabId) closeTab(activeTabId);
});

// Launched from a per-session desktop shortcut (see 创建桌面快捷方式):
// main process tells us which session to auto-connect once it's loaded.
let pendingAutoConnectId = null;
window.api.menu.onAutoConnect((sessionId) => {
  pendingAutoConnectId = sessionId;
  tryPendingAutoConnect();
});

function tryPendingAutoConnect() {
  if (!pendingAutoConnectId) return;
  const s = sessions.find((x) => x.id === pendingAutoConnectId);
  if (s) {
    pendingAutoConnectId = null;
    connectSession(s);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

refreshSessionList().then(tryPendingAutoConnect);
