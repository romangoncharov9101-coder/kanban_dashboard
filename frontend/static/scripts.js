'use strict';
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const API = window.location.origin + '/api';

const WS_BASE = isLocal 
    ? 'ws://localhost:8000' 
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let currentUser = null;
let ws = null, wsTimer = null;
let columns = [], cards = [], onlineUsers = [];
let boardSortable = null;
let searchTimeout = null;
const remoteDrags = new Map();
// [ADDED] Очередь файлов для карточек создаваемых впервые.
// При создании у нас ещё нет card_id → файлы копятся здесь,
// после POST /cards загружаются одним батчем.
let pendingFiles = [];
const cardSortables = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// TOAST / ALERTS  — заменяем все alert() красивыми тостами
// ─────────────────────────────────────────────────────────────────────────────
// type: 'error' | 'warn' | 'success' | 'info'
function showToast(message, type = 'info', duration = 4500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const activeModal = document.querySelector('dialog[open]');
  if (activeModal) {
    if (container.parentElement !== activeModal) {
      activeModal.appendChild(container);
    }
  } else {
    if (container.parentElement !== document.body) {
      document.body.appendChild(container);
    }
  }

  const styles = {
    error:   { bar: 'bg-red-500',    icon: '✕', ring: 'border-red-500',    text: 'text-red-700',    bg: 'bg-red-50'    },
    warn:    { bar: 'bg-amber-400',  icon: '⚠', ring: 'border-amber-400',  text: 'text-amber-700',  bg: 'bg-amber-50'  },
    success: { bar: 'bg-emerald-500',icon: '✓', ring: 'border-emerald-500',text: 'text-emerald-700',bg: 'bg-emerald-50'},
    info:    { bar: 'bg-indigo-500', icon: 'ℹ', ring: 'border-indigo-500', text: 'text-indigo-700', bg: 'bg-indigo-50' },
  };

  const s = styles[type] || styles.info;
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto border ${s.ring} ${s.bg} rounded-xl shadow-xl flex overflow-hidden animate-slide-in`;

  const bar = document.createElement('div');
  bar.className = `${s.bar} w-1.5 flex-shrink-0`;

  const body = document.createElement('div');
  body.className = 'flex items-start gap-3 px-4 py-3 flex-1 min-w-0';

  const iconEl = document.createElement('span');
  iconEl.className = `${s.text} font-bold text-base mt-0.5 flex-shrink-0`;
  iconEl.textContent = s.icon;
 
  const msgEl = document.createElement('span');
  msgEl.className = 'text-sm text-slate-700 flex-1 min-w-0 break-words';
  msgEl.textContent = message;   // textContent — XSS-safe
 
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-slate-400 hover:text-slate-600 ml-1 flex-shrink-0 text-lg leading-none';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => _removeToast(toast);
 
  body.appendChild(iconEl);
  body.appendChild(msgEl);
  body.appendChild(closeBtn);
  toast.appendChild(bar);
  toast.appendChild(body);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => _removeToast(toast), duration);
  }
  return toast;
}

const toast = {
  error:   (m, d) => showToast(m, 'error', d),
  warn:    (m, d) => showToast(m, 'warn', d),
  success: (m, d) => showToast(m, 'success', d),
  info:    (m, d) => showToast(m, 'info', d),
}

function _removeToast(toast) {
  toast.style.cssText = 'opacity:0;transform:translateX(120%);transition:all .3s ease';
  setTimeout(() => toast.remove(), 320);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// API helper
// ─────────────────────────────────────────────────────────────────────────────
async function api(method, path, body, quiet = false) {
  const opts = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(API+path, opts);
  if (res.status === 204) return null;
  const json = await res.json();

  if (!res.ok) {
    if (res.status === 401) _uiLoggedOut();
    if (!quiet) {
        const errMsg = json?.error?.message || json?.detail?.[0]?.msg
                   || json?.detail || json?.message || `Ошибка ${res.status}`;
        toast.error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
      }
      return null;
  }

  return json;
}

async function apiUpload(path, formData) {
  const res = await fetch(API + path, {method: 'POST', credentials: 'include', body: formData});

  if (res.status === 204) return null;
  const json = await res.json();

  if(!res.ok) {
    const errMsg = json?.error?.message || json?.detail || `Ошибка ${res.status}`;
    toast.error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
    return null;
  }
  return json;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// LOG
// ─────────────────────────────────────────────────────────────────────────────
function logEvent(type, msg) {
  const colors = {
    card_created:'text-emerald-600', card_updated:'text-blue-600',
    card_moved:'text-purple-600',  card_deleted:'text-red-500',
    card_dragging:'text-amber-500',
    column_created:'text-emerald-700', column_updated:'text-blue-700', column_deleted:'text-red-600',
    user_online:'text-emerald-500', user_offline:'text-slate-400',
    session_invalidated:'text-orange-500',
    error:'text-red-700', system:'text-slate-400',
  };

  const el = document.getElementById('event-log');
  if (!el) return;
  el.insertAdjacentHTML('afterbegin',
    `<div class="${colors[type] || 'text-slate-600'}">[${new Date().toLocaleTimeString()}] <b>${type}</b> ${esc(String(msg).substring(0, 120))}</div>`);
  while (el.children.length > 100) el.lastChild.remove();
}
function clearLog() { document.getElementById('event-log').innerHTML = ''; }

// ─────────────────────────────────────────────────────────────────────────────
// ESCAPE (XSS protection)
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
 
// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
// const _usernameRe = /^[a-zA-Zа-яА-ЯёЁ]{1,100}$/;
// const _colNameRe  = /^[a-zA-Zа-яА-ЯёЁ0-9\s]{1,100}$/;
// const _cardTitleRe = /^[a-zA-Zа-яА-ЯёЁ0-9\s.,!?\-_]{1,200}$/;

const _usernameRe = /^[a-zA-Zа-яА-ЯёЁ0-9]{1,100}$/;
const _colNameRe  = /^[a-zA-Zа-яА-ЯёЁ0-9\s]{1,100}$/;
 
async function doRegister() {
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value;

  if (!_usernameRe.test(u)) return toast.warn('Никнейм: только буквы и цифры, 1–100 символов');
  if (p.length < 6) return toast.warn('Пароль: минимум 6 символов');

  const d = await api('POST', '/users/register', { username: u, password: p });
  if (!d) return;
  await _uiLoggedIn(d);
  await loadBoard();
  toast.success(`Добро пожаловать, ${d.username}!`);
}
 
async function doLogin() {
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value;

  if (!u || !p) return toast.warn('Введите логин и пароль');

  const d = await api('POST', '/users/login', { username: u, password: p });
  if (!d) return;
  await _uiLoggedIn(d);
  await loadBoard();
}
 
async function doLogout() {
  await api('POST', '/users/logout');
  currentUser = null; columns = []; cards = []; onlineUsers = [];
  _disconnectWS();
  document.getElementById('board').innerHTML = '';
  document.getElementById('online-users').innerHTML = '';
  _uiLoggedOut();
  loadBoard();
}
 
async function _uiLoggedIn(user) {
  currentUser = { user_id: user.user_id, username: user.username };
  document.getElementById('auth-area').classList.add('hidden');
  const ui = document.getElementById('user-info');
  ui.classList.remove('hidden'); ui.classList.add('flex');
  document.getElementById('current-username').textContent = currentUser.username;
  document.getElementById('btn-add-col').disabled = false;
  connectWS();

  try {
    const status = await api('GET', '/notifications/check', undefined, true);
    if (status && status.has_new_tasks) showOfflineNotification();
  } catch {}
  renderBoard();
}
 
function _uiLoggedOut() {
  currentUser = null;
  document.getElementById('auth-area').classList.remove('hidden');
  const ui = document.getElementById('user-info');
  ui.classList.add('hidden'); ui.classList.remove('flex');
  document.getElementById('btn-add-col').disabled = true;
  document.getElementById('auth-password').value = '';
  renderBoard();
}
 
// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
function _disconnectWS() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  if (ws) {
    ws.onclose = null; ws.onerror = null; ws.onmessage = null;
    if (ws.readyState !== WebSocket.CLOSED) ws.close();
    ws = null;
  }
}

let _wsRetryDelay = 2000;
const _wsMaxDelay  = 60000;
 
function connectWS() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  if (ws) { ws.onclose = null; if (ws.readyState !== WebSocket.CLOSED) ws.close(); }
 
  ws = new WebSocket(`${WS_BASE}/ws`);
 
  ws.onopen = () => {
    _wsRetryDelay = 2000;
  };
 
  ws.onclose = () => {
    if (!currentUser) return;
    const jitter = (_wsRetryDelay * 0.2) * (Math.random() * 2 - 1);
    wsTimer = setTimeout(connectWS, _wsRetryDelay + jitter);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, _wsMaxDelay);
  };
 
  ws.onerror = () => logEvent('error', 'WS error — will retry');
 
  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.event === 'card_dragging') { _handleRemoteDrag(msg.payload); return; }
    if (msg.event === 'notification')  { showNotification(msg.payload); return; }
    if (msg.event === 'session_invalidated') {
      if (currentUser && msg.payload?.user_id === currentUser.user_id) {
        logEvent('session_invalidated', 'Сессия завершена на другой вкладке');
        _disconnectWS();
        currentUser = null; columns = []; cards = []; onlineUsers = [];
        document.getElementById('board').innerHTML = '';
        document.getElementById('online-users').innerHTML = '';
        _uiLoggedOut();
        toast.warn('Сессия завершена на другой вкладке', 0);
      }
      return;
    }
 
    logEvent(msg.event, JSON.stringify(msg.payload).substring(0, 120));

    switch (msg.event) {
      case 'column_created': case 'column_updated': case 'column_deleted':
      case 'card_created':   case 'card_updated':   case 'card_moved':   case 'card_deleted':
      case 'user_online':    case 'user_offline':   case 'user_created':
        schedulePartialReload(msg.event);
        break;
    }
  };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// УМНАЯ ОЧЕРЕДЬ ОБНОВЛЕНИЙ
// ───────────────────────────────────────────────────────────────────────────── 
let _pendingEvents = new Set();
let _reloadTimer = null;
let _reloading = false;
 
function schedulePartialReload(eventType) {
  _pendingEvents.add(eventType);
  if (_reloadTimer) return;
  _reloadTimer = setTimeout(_flushReload, 50);
}
 
async function _flushReload() {
  _reloadTimer = null;
  if (_reloading) { _reloadTimer = setTimeout(_flushReload, 100); return; }
 
  const events = new Set(_pendingEvents);
  _pendingEvents.clear();
 
  const needsFull    = events.has('user_created');
  const needsColumns = events.has('column_created') || events.has('column_updated') || events.has('column_deleted');
  const needsCards   = events.has('card_created')   || events.has('card_updated')   ||
                       events.has('card_deleted')   || events.has('card_moved');
  const needsOnline  = events.has('user_online')    || events.has('user_offline');
 
  _reloading = true;
  try {
    if      (needsFull)                       await loadBoard();
    else if (needsColumns && needsOnline)     await Promise.all([_loadColumns(), _loadOnlineUsers()]);
    else if (needsColumns)                    await _loadColumns();
    else if (needsCards && needsOnline)       await Promise.all([_loadCards(), _loadOnlineUsers()]);
    else if (needsCards)                      await _loadCards();
    else if (needsOnline)                     await _loadOnlineUsers();
  } finally {
    _reloading = false;
    if (_pendingEvents.size > 0 && !_reloadTimer) {
      _reloadTimer = setTimeout(_flushReload, 50);
    }
  }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// REMOTE DRAG HIGHLIGHT
// ─────────────────────────────────────────────────────────────────────────────
const _uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 
function _handleRemoteDrag({ card_id, dragged_by, username }) {
  if (currentUser && dragged_by === currentUser.user_id) return;
  if (!_uuidRe.test(card_id)) return;
  const el = document.querySelector(`[data-card-id="${card_id}"]`);
  if (el) { el.classList.add('remote-drag'); el.title = `Moving: ${esc(username)}`; }
  const prev = remoteDrags.get(card_id);
  if (prev) clearTimeout(prev);
  remoteDrags.set(card_id, setTimeout(() => {
    const e = document.querySelector(`[data-card-id="${card_id}"]`);
    if (e) { e.classList.remove('remote-drag'); e.title = ''; }
    remoteDrags.delete(card_id);
  }, 2000));
}
 
function _sendDragEvent(cardId, srcColId, curColId, curPos) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentUser) return;
  ws.send(JSON.stringify({
    event: 'card_dragging', card_id: cardId,
    source_column_id: srcColId, current_column_id: curColId, current_position: curPos,
  }));
}
 
// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────────────────────
async function loadBoard() {
  if (!currentUser) return;
  const [cols, crds, onl] = await Promise.all([
    api('GET', '/columns'),
    api('GET', '/cards'),
    api('GET', '/users/online'),
  ]);
  if (!cols || !crds || !onl) return;
  columns = cols; cards = crds; onlineUsers = onl;
  _renderOnlineUsers();
  renderBoard();
}
 
async function _loadCards() {
  if (!currentUser) return;
  const crds = await api('GET', '/cards');
  if (!crds) return;
  cards = crds;
  renderBoard();
}
 
async function _loadColumns() {
  if (!currentUser) return;
  const [cols, crds] = await Promise.all([
    api('GET', '/columns'),
    api('GET', '/cards'),
  ]);
  if (!cols || !crds) return;
  columns = cols; cards = crds;
  renderBoard();
}
 
async function _loadOnlineUsers() {
  if (!currentUser) return;
  const onl = await api('GET', '/users/online');
  if (!onl) return;
  onlineUsers = onl;
  _renderOnlineUsers();
}
 
function _renderOnlineUsers() {
  const el = document.getElementById('online-users');
  if (!el) return;
  el.innerHTML = onlineUsers.length
    ? onlineUsers.map(u => `<span class="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-xs">${esc(u.username)}</span>`).join('')
    : '<span class="text-gray-400 text-xs">nobody</span>';
}
 
// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────
function renderBoard() {
  if (boardSortable) { boardSortable.destroy(); boardSortable = null; }
  cardSortables.forEach(s => s.destroy()); cardSortables.clear();
 
  const board = document.getElementById('board');
  board.innerHTML = '';
 
  [...columns].sort((a, b) => a.position - b.position).forEach(col => {
    const colCards = cards
      .filter(c => c.column_id === col.id)
      .sort((a, b) => a.position - b.position);
    board.insertAdjacentHTML('beforeend', _renderColumn(col, colCards));
  });
 
  _initBoardSortable();
  columns.forEach(col => _initCardSortable(col.id));
}
 
function _renderColumn(col, colCards) {
  const ce = !!currentUser;
  const count = colCards.length;
  return `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col
                sm:min-w-[290px] sm:max-w-[290px] w-full"
         data-column-id="${col.id}">
      <!-- Header -->
      <div class="col-handle flex justify-between items-center px-4 pt-3 pb-2
                  border-b border-slate-100 select-none">
        <div class="flex items-center gap-2 min-w-0">
          <h3 class="font-semibold text-slate-800 truncate text-sm" title="${esc(col.name)}">${esc(col.name)}</h3>
          <span class="bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0">${count}</span>
        </div>
        ${ce ? `<button onclick="deleteColumn('${col.id}')"
          class="text-slate-400 hover:text-red-500 text-sm flex-shrink-0 ml-2" title="Удалить">✕</button>` : ''}
      </div>
      <!-- Cards -->
      <div class="card-list px-2 py-2 flex flex-col gap-2 flex-1 min-h-[48px]"
           data-col-id="${col.id}">
        ${colCards.map(c => _renderCard(c)).join('')}
      </div>
      <!-- Add card -->
      ${ce ? `<div class="px-2 pb-2">
        <button onclick="openAddCard('${col.id}')"
          class="w-full text-xs text-indigo-600 border border-dashed border-indigo-200
                 rounded-lg px-2 py-1.5 hover:bg-indigo-50 hover:border-indigo-400 transition-colors">
          + Задача
        </button>
      </div>` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER CARD  — preview image, deadline badge, download button
// ─────────────────────────────────────────────────────────────────────────────
function _deadlineBadge(deadline) {
  if (!deadline) return '';

  const dl = new Date(deadline);
  const now = Date.now();
  const diff = dl - now;
  let cls, label;

  if (diff < 0) {
    cls = 'deadline-overdue'; label = 'Прострочен';
  } else if (diff < 86400000) {
    cls = 'deadline-soon'; label = 'Скоро';
  } else {
    cls = 'deadline-ok'; label = '';
  }

  const dateStr = dl.toLocaleString([], { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  return `<span class="${cls} text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0">
    ${cls === 'deadline-ok' ? '🕐' : cls === 'deadline-soon' ? '⚡' : '🔴'} ${dateStr}${label ? ' · ' + label : ''}
  </span>`;
}

function _previewImage(attachments) {
  if (!attachments || !attachments.length) return '';
  const img = attachments.find(a => a.content_type && a.content_type.startsWith('image/'));
  if (!img) return '';
  const cardId = img.id;
  const src = `${API}/cards/${cardId}/attachments/${img.id}/download`;
  return `<img src="${src}" alt="${esc(img.filename)}"
    class="card-preview-img" loading="lazy"
    onerror="this.closest('.card-cover-container').style.display='none'" />`;
}
 
function _renderCard(c) {
  const creator  = c.created_by_username || '—';
  const assignee = c.assigned_to_username || null;
  const hasAttachments = c.attachments && c.attachments.length > 0;

  // [EDITED] Показываем дату СОЗДАНИЯ (не обновления) — пользователь хочет видеть когда задача была создана
  const createdDate = new Date(c.created_at).toLocaleString([], {
    day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
  });

  // [ADDED] Если есть дедлайн — показываем его отдельной строкой с датой
  const deadlineDate = c.deadline
    ? new Date(c.deadline).toLocaleString([], { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
    : null;
 
  return `
    <div class="card bg-white border border-slate-200 rounded-xl text-sm flex flex-col
                overflow-hidden hover:shadow-md hover:-translate-y-px transition-all duration-150 group"
         data-card-id="${c.id}" data-col-id="${c.column_id}"
         onclick="openEditCard('${c.id}')">
 
      ${_previewImage(c.attachments)}
 
      <div class="px-3 pt-2.5 pb-2 flex flex-col gap-1.5">
 
        <!-- Title row -->
        <div class="flex items-start justify-between gap-1">
          <span class="font-semibold text-slate-800 text-[13px] leading-tight line-clamp-2 flex-1"
                title="${esc(c.title)}">${esc(c.title)}</span>
          ${currentUser ? `
          <div class="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
               onclick="event.stopPropagation()">
            <button onclick="openEditCard('${c.id}')" title="Редактировать"
              class="text-slate-400 hover:text-indigo-600 p-0.5 rounded">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z"/>
              </svg>
            </button>
            <button onclick="deleteCard('${c.id}')" title="Удалить"
              class="text-slate-400 hover:text-red-500 p-0.5 rounded">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>` : ''}
        </div>
 
        ${c.description ? `<p class="text-slate-500 text-[11px] line-clamp-2 leading-relaxed">${esc(c.description)}</p>` : ''}
 
        <!-- Deadline badge -->
        ${c.deadline ? `<div class="mt-0.5">${_deadlineBadge(c.deadline)}</div>` : ''}
 
        <!-- Meta row -->
        <div class="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-100 mt-0.5">
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-[10px] text-slate-400 truncate">✍ ${esc(creator)}</span>
            ${assignee ? `<span class="text-[10px] text-indigo-500 font-medium truncate">👤 ${esc(assignee)}</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0" onclick="event.stopPropagation()">
            ${hasAttachments ? `
            <button onclick="downloadAllAttachmentsFor('${c.id}')" title="Скачать вложения (${c.attachments.length})"
              class="text-[10px] text-slate-500 hover:text-indigo-600 flex items-center gap-0.5 border border-slate-200
                     rounded-full px-1.5 py-0.5 hover:border-indigo-400 transition-colors">
              <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              ${c.attachments.length}
            </button>` : `
            <span class="text-[10px] text-slate-300 border border-slate-100 rounded-full px-1.5 py-0.5
                         cursor-not-allowed" title="Нет вложений">
              <svg class="w-2.5 h-2.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            </span>`}
            <!-- [EDITED] Показываем дату создания -->
            <span class="text-[10px] text-slate-400" title="Создана">📅 ${createdDate}</span>
          </div>
        </div>

        <!-- [ADDED] Дедлайн отдельной строкой под meta — только если задан -->
        ${deadlineDate ? `
        <div class="flex items-center justify-between pt-1 border-t border-slate-100">
          <span class="text-[10px] text-slate-400">Дедлайн</span>
          ${_deadlineBadge(c.deadline)}
        </div>` : ''}
 
      </div>
    </div>`;
}

function downloadAllAttachmentsFor(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (!card || !card.attachments || !card.attachments.length) {
    toast.info('Нет вложений для скачивания'); return;
  }
  _downloadAttachments(card.attachments);
}

function _downloadAttachments(attachments) {
  if (!attachments || !attachments.length) {toast.info('Нет вложений'); return;}
  const cardId = document.getElementById('card-edit-id').value;
  attachments.forEach((a, i) => {
    const attachmentId = a.id;
    setTimeout(() => {
      const link = document.createElement('a');
      link.href = `${API}/cards/${cardId}/attachments/${encodeURIComponent(attachmentId)}/download`;
      link.download = a.filename;
      link.click();
    }, i * 200);
  })
}
 
// ─────────────────────────────────────────────────────────────────────────────
// DEADLINE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _toDatetimeLocal(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d - offset).toISOString().slice(0, 16);
}

function setDeadlinePreset(days) {
  const d = new Date(Date.now() + days * 86400000);
  const input = document.getElementById('card-deadline-input');
  input.value = _toDatetimeLocal(d.toISOString());
  _updateDeadlineClearBtn();
  _validateDeadline();
}

function clearDeadline() {
  document.getElementById('card-deadline-input').value = '';
  document.getElementById('card-deadline-clear').classList.add('hidden');
  document.getElementById('deadline-error').classList.add('hidden');
}

function _updateDeadlineClearBtn() {
  const val = document.getElementById('card-deadline-input').value;
  document.getElementById('card-deadline-clear').classList.toggle('hidden', !val);
}

function _validateDeadline() {
  const input = document.getElementById('card-deadline-input');
  const errEl = document.getElementById('deadline-error');
  if (!input.value) { errEl.classList.add('hidden'); return null; }
 
  const selected = new Date(input.value);
  if (isNaN(selected)) { errEl.classList.add('hidden'); return null; }
 
  if (selected <= new Date()) {
    errEl.classList.remove('hidden');
    input.classList.add('border-red-400', 'ring-red-300');
    return false;
  }
  errEl.classList.add('hidden');
  input.classList.remove('border-red-400', 'ring-red-300');
  return selected.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL: ATTACHMENTS (in edit mode)
// ─────────────────────────────────────────────────────────────────────────────
function _renderAttachmentsList(attachments) {
  const list = document.getElementById('attachments-list');
  const dlBtn = document.getElementById('btn-download-all');

  if (!list) return;
  if (!attachments || !attachments.length) {
    list.innerHTML = '<p class="text-xs text-slate-400 italic">Нет вложений</p>';
    if (dlBtn) dlBtn.disabled = true;
    return;
  }

  if (dlBtn) dlBtn.disabled = false;

  list.innerHTML = '';
  attachments.forEach(a =>{
    const isImage = a.content_type && a.content_type.startsWith('image/');
    const iconEl  = isImage ? '🖼' : '📄';
    const item    = document.createElement('div');
    item.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs';
 
    const iconSpan = document.createElement('span');
    iconSpan.textContent = iconEl;
 
    const nameEl = document.createElement('span');
    nameEl.className = 'flex-1 truncate text-slate-700';
    nameEl.textContent = a.filename;
 
    const dlLink = document.createElement('a');
    const cardId = document.getElementById('card-edit-id').value;
    dlLink.href = `${API}/cards/${cardId}/attachments/${encodeURIComponent(a.id)}/download`;
    dlLink.download = a.filename;
    dlLink.className = 'text-indigo-500 hover:text-indigo-700 flex-shrink-0';
    dlLink.title = 'Скачать';
    dlLink.textContent = '⬇';
 
    const delBtn = document.createElement('button');
    delBtn.className = 'text-red-400 hover:text-red-600 flex-shrink-0';
    delBtn.title = 'Удалить';
    delBtn.textContent = '✕';
    delBtn.onclick = () => deleteAttachment(a.id);
 
    item.appendChild(iconSpan);
    item.appendChild(nameEl);
    item.appendChild(dlLink);
    item.appendChild(delBtn);
    list.appendChild(item);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАГРУЗКА ФАЙЛОВ — drag-and-drop, file input, paste из буфера
// ─────────────────────────────────────────────────────────────────────────────

// [ADDED] Обработчик drop на зону
function handleFileDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('drop-zone');
  zone.classList.remove('border-indigo-500', 'bg-indigo-50');
  const files = Array.from(event.dataTransfer.files);
  _processFiles(files);
}

// [ADDED] Обработчик выбора через file input (поддерживает multiple)
function handleFileInputChange(event) {
  const files = Array.from(event.target.files);
  event.target.value = ''; // сброс чтобы можно было загрузить тот же файл снова
  _processFiles(files);
}

// [ADDED] Единая точка входа для файлов — решает куда их отправить:
// если редактируем существующую карточку (есть card-edit-id) → сразу на сервер,
// если создаём новую → кладём в pendingFiles, загрузим после POST /cards.
async function _processFiles(files) {
  const MAX_SIZE = 10 * 1024 * 1024;
  const ALLOWED  = ['image/', 'application/pdf', 'application/msword',
                    'application/vnd.openxmlformats', 'application/vnd.ms-excel',
                    'text/plain', 'application/zip'];

  const cardId = document.getElementById('card-edit-id').value;

  for (const file of files) {
    // Валидация размера
    if (file.size > MAX_SIZE) {
      toast.warn(`«${file.name}» слишком большой (макс. 5 МБ)`); continue;
    }
    // Мягкая проверка типа (не блокируем строго — сервер проверит сам)
    const allowed = ALLOWED.some(t => file.type.startsWith(t));
    if (!allowed) {
      toast.warn(`«${file.name}» — неподдерживаемый тип файла`); continue;
    }

    if (cardId) {
      // Режим редактирования — загружаем сразу
      await _uploadFileTo(cardId, file);
    } else {
      // Режим создания — буферизуем в pendingFiles
      _addToPending(file);
    }
  }
}

function _addToPending(file) {
  // Не добавляем дубликаты
  if (pendingFiles.find(f => f.name === file.name && f.size === file.size)) {
    toast.info(`«${file.name}» уже в списке`); return;
  }
  pendingFiles.push(file);
  _renderPendingList();
}

function _renderPendingList() {
  const list  = document.getElementById('attachments-list');
  const dlBtn = document.getElementById('btn-download-all');
  if (!list) return;

  if (!pendingFiles.length) {
    list.innerHTML = '<p class="text-xs text-slate-400 italic">Нет файлов</p>';
    if (dlBtn) dlBtn.disabled = true;
    return;
  }

  if (dlBtn) dlBtn.disabled = true;

  list.innerHTML = '';
  pendingFiles.forEach((file, idx) => {
    const isImage = file.type.startsWith('image/');
    const item = document.createElement('div');
    item.className = 'flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs';

    const icon = document.createElement('span');
    icon.textContent = isImage ? '🖼' : '📄';

    const name = document.createElement('span');
    name.className = 'flex-1 truncate text-slate-700';
    name.textContent = file.name;

    const badge = document.createElement('span');
    badge.className = 'text-amber-600 text-[10px] flex-shrink-0';
    badge.textContent = 'ожидает';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'text-red-400 hover:text-red-600 flex-shrink-0';
    removeBtn.title = 'Убрать';
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => {
      pendingFiles.splice(idx, 1);
      _renderPendingList();
    };

    item.appendChild(icon); item.appendChild(name);
    item.appendChild(badge); item.appendChild(removeBtn);
    list.appendChild(item);
  });
}

async function _uploadFileTo(cardId, file) {
  const fd = new FormData();
  fd.append('file', file);
  const result = await apiUpload(`/cards/${cardId}/attachments`, fd);
  if (result) {
    toast.success(`«${file.name}» прикреплён`);
    const card = cards.find(c => c.id === cardId);
    if (card) {
      if (!card.attachments) card.attachments = [];
      card.attachments.push(result);
      _renderAttachmentsList(card.attachments);
      renderBoard();
    }
  }
}

async function _flushPendingFiles(cardId) {
  if (!pendingFiles.length) return;
  const files = [...pendingFiles];
  pendingFiles = [];
  for (const file of files) {
    await _uploadFileTo(cardId, file);
  }
}

async function uploadAttachment() {
  const cardId = document.getElementById('card-edit-id').value;
  const fileInput = document.getElementById('attachment-file-input');
  if (!fileInput.files.length) return;
  await _processFiles(Array.from(fileInput.files));
  fileInput.value = '';
}

async function deleteAttachment(attachmentId) {
  const cardId = document.getElementById('card-edit-id').value;
  await api('DELETE', `/cards/attachments/${attachmentId}`);
  const card = cards.find(c => c.id === cardId);
  if (card && card.attachments) {
    card.attachments = card.attachments.filter(a => a.id !== attachmentId);
    _renderAttachmentsList(card.attachments);
    renderBoard();
  }
  toast.success('Вложение удалено');
}

function downloadAllAttachments() {
  const cardId = document.getElementById('card-edit-id').value;
  const card = cards.find(c => c.id === cardId);
  if (!card) return;
  _downloadAttachments(card.attachments);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
function showNotification(payload) {
  const container = _getToastContainer();
  const toast_ = document.createElement('div');
  toast_.className = 'pointer-events-auto border border-indigo-300 bg-indigo-50 rounded-xl shadow-xl flex overflow-hidden animate-slide-in';
 
  const bar = document.createElement('div');
  bar.className = 'bg-indigo-500 w-1.5 flex-shrink-0';
 
  const body = document.createElement('div');
  body.className = 'px-4 py-3 flex flex-col gap-1 flex-1 min-w-0';
 
  const header = document.createElement('div');
  header.className = 'flex justify-between items-center';
  const label = document.createElement('span');
  label.className = 'text-indigo-600 font-bold text-[10px] uppercase tracking-widest';
  label.textContent = 'Новая задача';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-slate-400 hover:text-slate-600 text-lg leading-none';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => _removeToast(toast_);
  header.appendChild(label); header.appendChild(closeBtn);
 
  const titleEl = document.createElement('div');
  titleEl.className = 'text-slate-800 font-semibold text-sm';
  titleEl.textContent = payload.card_title || '';
 
  const fromEl = document.createElement('div');
  fromEl.className = 'text-slate-500 text-xs';
  fromEl.textContent = 'Назначил: ';
  const fromName = document.createElement('span');
  fromName.className = 'font-medium text-slate-700';
  fromName.textContent = payload.from_user || '';
  fromEl.appendChild(fromName);
 
  body.appendChild(header); body.appendChild(titleEl); body.appendChild(fromEl);
  toast_.appendChild(bar); toast_.appendChild(body);
  container.appendChild(toast_);
  setTimeout(() => _removeToast(toast_), 6000);
}

async function showOfflineNotification() {
  const container = _getToastContainer();
  const t = document.createElement('div');
  t.className = 'pointer-events-auto border-2 border-indigo-400 bg-indigo-50 rounded-xl shadow-2xl p-4 animate-bounce-in flex flex-col gap-3';
 
  const row = document.createElement('div');
  row.className = 'flex items-center gap-3';
 
  const iconBox = document.createElement('div');
  iconBox.className = 'bg-indigo-500 text-white p-2 rounded-lg flex-shrink-0 text-lg';
  iconBox.textContent = '🔔';
 
  const textBox = document.createElement('div');
  const h4 = document.createElement('h4');
  h4.className = 'font-bold text-slate-900 text-sm';
  h4.textContent = 'Пока вас не было…';
  const p = document.createElement('p');
  p.className = 'text-slate-600 text-xs';
  p.textContent = 'Вам назначены новые задачи!';
  textBox.appendChild(h4); textBox.appendChild(p);
 
  row.appendChild(iconBox); row.appendChild(textBox);
 
  const btn = document.createElement('button');
  btn.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 rounded-lg transition-colors';
  btn.textContent = 'Понятно, спасибо!';
  btn.onclick = async () => {
    await api('DELETE', '/notifications/clear');
    _removeToast(t);
  };
 
  t.appendChild(row); t.appendChild(btn);
  container.prepend(t);
}

function _getToastContainer() {
  let c = document.getElementById('toast-container');
  const activeModal = document.querySelector('dialog[open]');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none w-80 max-w-[calc(100vw-2rem)]';
    document.body.appendChild(c);
  }

  if (activeModal && c.parentElement !== activeModal) {
    activeModal.appendChild(c);
  } else if (!activeModal && c.parentElement !== document.body) {
    document.body.appendChild(c);
  }
  return c;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// SORTABLEJS: COLUMNS
// ─────────────────────────────────────────────────────────────────────────────
function _initBoardSortable() {
  boardSortable = Sortable.create(document.getElementById('board'), {
    animation: 200,
    handle: '.col-handle',
    ghostClass: 'col-ghost', dragClass: 'col-drag', chosenClass: 'col-chosen',
    disabled: !currentUser,
    async onEnd(evt) {
      if (!currentUser || evt.oldIndex === evt.newIndex) return;
 
      const colId  = evt.item.dataset.columnId;
      const newPos = evt.newIndex;
      const movedCol = columns.find(c => c.id === colId);

      if (movedCol) {
        columns.splice(evt.oldIndex, 1);
        columns.splice(evt.newIndex, 0, movedCol);
        columns.forEach((c, i) => c.position = i);
      }
      const result = await api('PUT', `/columns/${colId}`, { position: newPos });
      if (!result) {
        // Откат при ошибке
        await loadBoard();
      }
    },
  });
}
 
function _initCardSortable(columnId) {
  const listEl = document.querySelector(`.card-list[data-col-id="${columnId}"]`);
  if (!listEl) return;
  let srcColId = null, cardId = null, throttle = null;
 
  const s = Sortable.create(listEl, {
    group: 'cards',
    animation: 150,
    ghostClass: 'card-ghost', dragClass: 'card-drag', chosenClass: 'card-chosen',
    disabled: !currentUser,
 
    onStart(e) { cardId = e.item.dataset.cardId; srcColId = e.item.dataset.colId; },
 
    onMove(e) {
      if (!cardId || !currentUser) return;
      if (throttle) return;
      throttle = setTimeout(() => { throttle = null; }, 80);
      _sendDragEvent(cardId, srcColId, e.to.dataset.colId,
        Math.max(0, Array.from(e.to.children).indexOf(e.related)));
    },
 
    async onEnd(e) {
      if (throttle) { clearTimeout(throttle); throttle = null; }
      if (!cardId || !currentUser) return;

      const mid = cardId, tCol = e.to.dataset.colId, tPos = e.newIndex ?? 0;
      cardId = srcColId = null;
      const card = cards.find(c => c.id === mid);

      if (card) { card.column_id = tCol; card.position = tPos; }
      const result = await api('POST', `/cards/${mid}/move`, {
        target_column_id: tCol, target_position: tPos,
      });
      if (!result) await loadBoard();
    },
  });
  cardSortables.set(columnId, s);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// COLUMN ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
function openAddColumn() {
  document.getElementById('new-col-name').value = '';
  document.getElementById('modal-add-column').showModal();
  setTimeout(() => document.getElementById('new-col-name').focus(), 50);
}
 
async function submitAddColumn() {
  const name = document.getElementById('new-col-name').value.trim();
  if (!name) return toast.warn('Название колонки обязательно');
  if (!_colNameRe.test(name)) return toast.warn('Название: только буквы, цифры и пробелы');
  const result = await api('POST', '/columns', { name });
  if (!result) return;
  document.getElementById('modal-add-column').close();
}
 
async function deleteColumn(id) {
  if (!confirm('Удалить колонку? (Она должна быть пустой)')) return;
  await api('DELETE', `/columns/${id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNEE SEARCH
// ─────────────────────────────────────────────────────────────────────────────
function _initAssigneeSearch() {
  const input = document.getElementById('card-assign-search');
  const datalist = document.getElementById('assign-suggestions');
  const hiddenId = document.getElementById('card-assign-id');

  if (!input) return;

  input.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchTimeout);

    if (query.length < 1) {
      datalist.innerHTML = '';
      hiddenId.value = '';
      return;
    }

    searchTimeout = setTimeout(async () => {
      const users = await api('GET', `/users/search?q=${encodeURIComponent(query)}`, undefined, true);
      if (users) {
        datalist.innerHTML = users
          .map(u => `<option value="${esc(u.username)}" data-id="${u.user_id}">`)
          .join('');

        const match = users.find(u => u.username === query);
        hiddenId.value = match ? match.user_id : '';
      }
    }, 300);
  });

  input.addEventListener('change', (e) => {
    const val = e.target.value;
    const opts = datalist.childNodes;
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].value === val) {
        hiddenId.value = opts[i].getAttribute('data-id');
        break;
      }
    }
  });
}
 
// ─────────────────────────────────────────────────────────────────────────────
// CARD ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
function openAddCard(colId) {
  document.getElementById('modal-card-title').textContent = 'New Card';
  document.getElementById('card-edit-id').value = '';
  document.getElementById('card-col-id').value = colId;
  document.getElementById('card-title-input').value = '';
  document.getElementById('card-desc-input').value = '';
  document.getElementById('card-assign-search').value = '';
  document.getElementById('card-assign-id').value = '';
  clearDeadline();
  pendingFiles = [];
  _renderPendingList();
  document.getElementById('modal-card').showModal();
  setTimeout(() => document.getElementById('card-title-input').focus(), 50);
}
 
function openEditCard(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (!card) return;
  document.getElementById('modal-card-title').textContent = 'Edit Card';
  document.getElementById('card-edit-id').value = cardId;
  document.getElementById('card-col-id').value = card.column_id;
  document.getElementById('card-title-input').value = card.title;
  document.getElementById('card-desc-input').value = card.description || '';
  document.getElementById('card-assign-search').value = card.assigned_to_username || '';
  document.getElementById('card-assign-id').value = card.assigned_to || '';
  const dlInput = document.getElementById('card-deadline-input');
  dlInput.value = card.deadline ? _toDatetimeLocal(card.deadline) : '';
  _updateDeadlineClearBtn();
  document.getElementById('deadline-error').classList.add('hidden');
  pendingFiles = [];
  _renderAttachmentsList(card.attachments || []);
  document.getElementById('modal-card').showModal();
  setTimeout(() => document.getElementById('card-title-input').focus(), 50);
}
 
async function submitCard() {
  const editId     = document.getElementById('card-edit-id').value;
  const colId      = document.getElementById('card-col-id').value;
  const title      = document.getElementById('card-title-input').value.trim();
  const desc       = document.getElementById('card-desc-input').value.trim();
  const assigneeId = document.getElementById('card-assign-id').value.trim() || null;

 
  if (!title) return toast.warn('Заголовок обязателен');

  const deadlineRaw = document.getElementById('card-deadline-input').value;
  let deadline = null;
  if (deadlineRaw) {
    deadline = _validateDeadline();
    if (deadline === false) {
      toast.error('Дедлайн должен быть позже текущего времени');
      return;
    }
  }
 
  const payload = { title, description: desc || null, assigned_to: assigneeId, deadline };
 
  let result;
  if (editId) {
    result = await api('PUT', `/cards/${editId}`, payload);
  } else {
    result = await api('POST', '/cards', {
      ...payload, column_id: colId, created_by: currentUser.user_id,
    });
    if (result && pendingFiles.length) {
      await _flushPendingFiles(result.id);
    }
  }
  if (result) document.getElementById('modal-card').close();
  toast.success(editId ? 'Задача обновлена' : 'Задача создана');
  renderBoard();
}
 
async function deleteCard(id) {
  if (!confirm('Удалить карточку?')) return;
  await api('DELETE', `/cards/${id}`);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  _initAssigneeSearch();

  document.getElementById('card-deadline-input')?.addEventListener('input', () => {
    _updateDeadlineClearBtn();
    _validateDeadline();
  });

  document.addEventListener('paste', (e) => {
    const modal = document.getElementById('modal-card');
    // Срабатываем только если модал карточки открыт
    if (!modal || !modal.open) return;
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      _processFiles(files);
    }
  });

  const me = await api('GET', '/users/me', undefined, true);
  if (me && me.user_id) {
    await _uiLoggedIn(me);
    await loadBoard();
  } else {
    _uiLoggedOut();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.tagName !== 'DIALOG') return;
  const r = e.target.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) e.target.close();
});