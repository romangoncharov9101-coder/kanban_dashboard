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
let pendingFiles = [];
let pendingDeletions = [];
let currentSortMode = 'position';
let currentFilterMode = 'all';
let lastSpacePress = 0;
let lastAPress = 0;
let lastCommentId = null;
let commentsHasMore = true;
let isLoadingComments = false;
let lastEventId = null;
let historyHasMore = true;
let isLoadingHistory = false;
let isDragging = false;
const remoteDrags = new Map();
const cardSortables = new Map();
const DOUBLE_PRESS_DELAY = 300;
const COMMENTS_LIMIT = 20;
const EVENTS_LIMIT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// TOAST / ALERTS
// ─────────────────────────────────────────────────────────────────────────────
// type: 'error' | 'warn' | 'success' | 'info'
function showToast(message, type = 'info', duration = 3000, quite = false) {
  if (quite === true) return;
  const container = document.getElementById('toast-container');
  if (!container) return;

  const currentToasts = Array.from(container.children).filter(t => t.style.opacity !== '0');
  
  if (currentToasts.length >= 3) {
    _removeToast(currentToasts[0]);
  }

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
  msgEl.textContent = message;
 
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
async function api(method, path, body, quite = false) {
  const opts = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(API+path, opts);
  if (res.status === 204) return null;
  let json = null;
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
      try {
          json = await res.json();
      } catch (e) {
          console.warn("Не удалось распарсить JSON", e);
      }
  }

  if (!res.ok) {
    if (res.status === 401) {
      const wasLoggedIn = !!currentUser;
      _uiLoggedOut();
      if (path === '/users/login') {
        const errMsg = json?.detail || json?.message || 'Неверный логин или пароль';
        toast.error(errMsg);
        return null;
      }
      if (!wasLoggedIn || quite) return null; 
      return null;
    }
    if (!quite) {
        const errMsg = json?.error?.message || json?.detail?.[0]?.msg
                   || json?.detail || json?.message || `Ошибка ${res.status}`;
        toast.error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), quite);
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
    toast.error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), quite=true);
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

const _usernameRe = /^[a-zA-Zа-яА-ЯёЁґҐєЄіІїЇ0-9]{1,100}$/;
const _colNameRe  = /^[a-zA-Zа-яА-ЯёЁґҐєЄіІїЇ0-9\s]{1,100}$/;
 
async function doRegister() {
  const u = (document.getElementById('auth-username')?.value || document.getElementById('auth-username-m')?.value || '').trim();
  const p = document.getElementById('auth-password')?.value || document.getElementById('auth-password-m')?.value || '';

  if (!_usernameRe.test(u)) return toast.warn('Никнейм: только буквы и цифры, 1–100 символов');
  if (p.length < 6) return toast.warn('Пароль: минимум 6 символов');

  const d = await api('POST', '/users/register', { username: u, password: p });
  if (!d) return;
  await _uiLoggedIn(d);
  await loadBoard();
  toast.success(`Добро пожаловать, ${d.username}!`);
}
 
async function doLogin() {
  const u = (document.getElementById('auth-username')?.value || document.getElementById('auth-username-m')?.value || '').trim();
  const p = document.getElementById('auth-password')?.value || document.getElementById('auth-password-m')?.value || '';

  if (!u || !p) return toast.warn('Введите логин и пароль');

  const d = await api('POST', '/users/login', { username: u, password: p });
  if (!d) return;
  await _uiLoggedIn(d);
  await loadBoard();
}
 
async function doLogout() {
  await api('POST', '/users/logout');
  currentUser = null; columns = []; cards = []; onlineUsers = [];
  _pendingEvents.clear();
  if (_reloadTimer) { 
    clearTimeout(_reloadTimer);
    _reloadTimer = null; 
  }
  _disconnectWS();
  document.getElementById('board').innerHTML = '';
  document.getElementById('online-users').innerHTML = '';
  _uiLoggedOut();
  await loadBoard();
}
 
async function _uiLoggedIn(user) {
  currentUser = { user_id: user.user_id, username: user.username };

  const authDesktop = document.getElementById('auth-area-desktop');
  if (authDesktop) authDesktop.classList.add('hidden');
  const uiDesktop = document.getElementById('user-info');
  if (uiDesktop) { uiDesktop.classList.remove('hidden'); uiDesktop.classList.add('flex'); }
  const unDesktop = document.getElementById('current-username');
  if (unDesktop) unDesktop.textContent = currentUser.username;

  const authMobile = document.getElementById('auth-area');
  if (authMobile) authMobile.classList.add('hidden');
  const uiMobile = document.getElementById('user-info-mobile');
  if (uiMobile) { uiMobile.classList.remove('hidden'); uiMobile.classList.add('flex'); }
  const unMobile = document.getElementById('current-username-m');
  if (unMobile) unMobile.textContent = currentUser.username;

  document.getElementById('btn-add-col').disabled = false;
  connectWS();
  renderBoard();

  try {
    const status = await api('GET', '/notifications/check', undefined, true);
    if (status && status.has_new_tasks) showOfflineNotification();
  } catch {}
}
 
function _uiLoggedOut() {
  currentUser = null;

  const authDesktop = document.getElementById('auth-area-desktop');
  if (authDesktop) authDesktop.classList.remove('hidden');
  const uiDesktop = document.getElementById('user-info');
  if (uiDesktop) { uiDesktop.classList.add('hidden'); uiDesktop.classList.remove('flex'); }

  const authMobile = document.getElementById('auth-area');
  if (authMobile) authMobile.classList.remove('hidden');
  const uiMobile = document.getElementById('user-info-mobile');
  if (uiMobile) { uiMobile.classList.add('hidden'); uiMobile.classList.remove('flex'); }

  document.getElementById('btn-add-col').disabled = true;

  const pwDesktop = document.getElementById('auth-password');
  if (pwDesktop) pwDesktop.value = '';
  const pwMobile = document.getElementById('auth-password-m');
  if (pwMobile) pwMobile.value = '';

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
    if (msg.event === 'comment_created') {
      const payload = msg.payload;
      const openCardId = document.getElementById('card-edit-id')?.value;
      const newComment = payload.comment || payload;
      
      if (openCardId === payload.card_id || openCardId === newComment.card_id) {
        const existing = document.querySelector(`.comment-item[data-id="${newComment.id}"]`);
        if (!existing) {
          _renderCommentsBatch([newComment], false);
          
          const list = document.getElementById('comments-list');
          if (list) {
              setTimeout(() => {
                  list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
              }, 50);
          }
        }
      }
      schedulePartialReload(msg.event);
    }
 
    logEvent(msg.event, JSON.stringify(msg.payload).substring(0, 120));

    switch (msg.event) {
      case 'column_created':    case 'column_updated':    case 'column_deleted':
      case 'card_created':      case 'card_updated':      case 'card_moved':   case 'card_deleted':
      case 'user_online':       case 'user_offline':      case 'user_created':
      case 'comment_created':   case 'comment_updated':   case 'comment_deleted':
      case 'card_archived':     case 'card_restored':
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
  _reloadTimer = setTimeout(_flushReload, 10);
}
 
async function _flushReload() {
  _reloadTimer = null;
  if (_reloading) { _reloadTimer = setTimeout(_flushReload, 100); return; }
 
  const events = new Set(_pendingEvents);
  _pendingEvents.clear();

  const needsComments = events.has('comment_created') || events.has('comment_updated') || events.has('comment_deleted');
 
  const needsFull    = events.has('user_created');
  const needsColumns = events.has('column_created') || events.has('column_updated') || events.has('column_deleted');
  const needsCards   = events.has('card_created')   || events.has('card_updated')   ||
                       events.has('card_deleted')   || events.has('card_moved')     ||
                       events.has('card_archived')  || events.has('card_restored')  ||
                       needsComments;
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
  const data = await api('GET', '/board/init');
  columns = data.columns || [];
  cards = data.cards || [];
  onlineUsers = data.online_users || [];

  sessionStorage.setItem('last_board_state', JSON.stringify(data));

  renderBoard();
}
 
async function _loadCards() {
  if (!currentUser) return;
  
  const crds = await api('GET', `/cards`);
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
  document.querySelectorAll('.card-list').forEach(c => c.innerHTML = '');
  if (boardSortable) { boardSortable.destroy(); boardSortable = null; }
  cardSortables.forEach(s => s.destroy()); cardSortables.clear();
 
  const board = document.getElementById('board');
  board.innerHTML = '';

  const isArchived = currentFilterMode === 'archived';

  const boardEl = document.getElementById('board');
  if (isArchived) {
      boardEl.classList.add('archive-mode');
  } else {
      boardEl.classList.remove('archive-mode');
  }

  const btnAddCol = document.getElementById('btn-add-col');
  if (btnAddCol) {
    btnAddCol.style.display = (currentUser && !isArchived) ? '' : 'none';
  }

  const sorter = getCardSorted();
  const filter = getCardFilter();
  const sortedCols = [...columns].sort((a, b) => a.position - b.position);

  sortedCols.forEach(col => {
        const colCards = cards
            .filter(c => c.column_id === col.id)
            .filter(filter)
            .sort(sorter);

        board.insertAdjacentHTML('beforeend', _renderColumn(col, colCards));
    });


  if (currentFilterMode !== 'archived') {
    _initBoardSortable();
    columns.forEach(col => _initCardSortable(col.id));
  } else {
    cardSortables.forEach(s => s.destroy());
    cardSortables.clear();
  }

  updateColumnsVisibility();
}
 
function _renderColumn(col, colCards) {
  const ce = !!currentUser;
  const isArchived = currentFilterMode === 'archived';
  const count = colCards.length;
  return `
    <div class="column bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col
                sm:min-w-[290px] sm:max-w-[290px] w-full"
         data-column-id="${col.id}">
      <!-- Header -->
      <div class="col-handle flex justify-between items-center px-4 pt-3 pb-2
                  border-b border-slate-100 select-none">
        <div class="flex items-center gap-2 min-w-0">
          <h3 class="font-semibold text-slate-800 truncate text-sm" title="${esc(col.name)}">${esc(col.name)}</h3>
          <span class="bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0">${count}</span>
          ${isArchived ? `<span class="bg-amber-100 text-amber-600 text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide">архив</span>` : ''}
        </div>
        ${ce && !isArchived ? `<button onclick="deleteColumn('${col.id}')"
          class="text-slate-400 hover:text-red-500 text-sm flex-shrink-0 ml-2" title="Удалить">✕</button>` : ''}
      </div>
      <!-- Add card (скрыто в режиме архива) -->
      ${ce && !isArchived ? `<div class="px-2 pb-2">
        <button onclick="openAddCard('${col.id}')"
          class="w-full text-xs text-indigo-600 border border-dashed border-indigo-200
                 rounded-lg px-2 py-1.5 hover:bg-indigo-50 hover:border-indigo-400 transition-colors">
          + Задача
        </button>
      </div>` : ''}
      <!-- Cards -->
      <div class="card-list px-2 py-2 flex flex-col gap-2 flex-1 min-h-[48px]"
           data-col-id="${col.id}">
        ${colCards.map(c => _renderCard(c)).join('')}
      </div>
    </div>`;
}

function updateColumnsVisibility() {
  const allColEls = document.querySelectorAll('[data-column-id]');
  if (allColEls.length === 0) return;

  const filterFn = getCardFilter();

  const visibleCards = cards.filter(filterFn);

  allColEls.forEach(colEl => {
    const colId = colEl.getAttribute('data-column-id');
    
    const hasCards = visibleCards.some(c => String(c.column_id) === String(colId));

    if (currentFilterMode === 'all') {
      colEl.classList.remove('hidden');
    } else {
      if (hasCards) {
        colEl.classList.remove('hidden');
      } else {
        colEl.classList.add('hidden');
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER CARD
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
  const commentsCount = c.comments_count || 0;

  const createdDate = new Date(c.created_at).toLocaleString([], {
    day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
  });

  const deadlineDate = c.deadline
    ? new Date(c.deadline).toLocaleString([], { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
    : null;

  const priorityMap = {
    'HIGHT': { color: 'bg-red-500', text: 'Высокий', bg: 'bg-red-50', textColor: 'text-red-700' },
    'MEDIUM': { color: 'bg-amber-500', text: 'Средний', bg: 'bg-amber-50', textColor: 'text-amber-700' },
    'LOW': { color: 'bg-slate-400', text: 'Низкий', bg: 'bg-slate-50', textColor: 'text-slate-600' }
  };

  const p = priorityMap[c.priority] || priorityMap['LOW'];
 
  return `
    <div class="card bg-white border border-slate-200 rounded-xl text-sm flex flex-col
                overflow-hidden hover:shadow-md hover:-translate-y-px transition-all duration-150 group relative"
         data-card-id="${c.id}" data-col-id="${c.column_id}"
         onclick="openEditCard('${c.id}')">

      <div class="absolute left-0 top-0 bottom-0 w-1 ${p.color}"></div>

      ${_previewImage(c.attachments)}

      <div class="pl-4 pr-3 pt-2.5 pb-2 flex flex-col gap-1.5"> 
        <div class="flex items-start justify-between gap-1">
          <div class="flex flex-col gap-1 flex-1">
            <span class="inline-block w-fit px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${p.bg} ${p.textColor}">
              ${p.text}
            </span>
            <span class="font-semibold text-slate-800 text-[13px] leading-tight line-clamp-2"
                  title="${esc(c.title)}">${esc(c.title)}</span>
          </div>

          ${currentUser ? `
          <div class="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
               onclick="event.stopPropagation()">
               ${c.is_archived ? `
              <button onclick="unarchiveCardAction(event, '${c.id}')" title="Вернуть из архива"
                class="text-amber-500 hover:text-amber-600 p-0.5 rounded">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              </button>
            ` : `
              <button onclick="archiveCardAction(event, '${c.id}')" title="В архив"
                class="text-slate-400 hover:text-amber-500 p-0.5 rounded">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              </button>
            `}
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

        ${c.deadline ? `<div class="mt-0.5">${_deadlineBadge(c.deadline)}</div>` : ''}

        <div class="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-100 mt-0.5">
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-[10px] text-slate-400 truncate">✍ ${esc(creator)}</span>
            ${assignee ? `<span class="text-[10px] text-indigo-500 font-medium truncate">👤 ${esc(assignee)}</span>` : ''}
          </div>
          
          <div class="flex items-center gap-1 flex-shrink-0">
            <div class="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-transparent 
                        ${commentsCount > 0 ? 'text-indigo-600 bg-indigo-50 border-indigo-100' : 'text-slate-300'}" 
                 title="Комментарии: ${commentsCount}">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
              <span class="text-[10px] font-bold">${commentsCount}</span>
            </div>

            ${hasAttachments ? `
            <button onclick="event.stopPropagation(); downloadAllAttachmentsFor('${c.id}')" title="Скачать вложения (${c.attachments.length})"
              class="text-[10px] text-slate-500 hover:text-indigo-600 flex items-center gap-0.5 border border-slate-200
                     rounded-full px-1.5 py-0.5 hover:border-indigo-400 transition-colors bg-white">
              <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              ${c.attachments.length}
            </button>` : ''}
          </div>
        </div> 
      </div>
    </div>`;
}

function downloadAllAttachmentsFor(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (!card || !card.attachments || !card.attachments.length) {
    toast.info('Нет вложений для скачивания'); return;
  }
  _downloadAttachments(card.attachments, card.id);
}

function _downloadAttachments(attachments, cardId = null) {
  if (!attachments || !attachments.length) {toast.info('Нет вложений'); return;}
  if (cardId === null) { cardId = document.getElementById('card-edit-id').value; }
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

async function archiveCardAction(e, cardId) {
  if (e) e.stopPropagation(); 
  if (!confirm('Переместить карточку в архив?')) return;

  const res = await api('POST', `/cards/${cardId}/archive`);
  if (res) {
    toast.success('Карточка перемещена в архив');
    
    const card = cards.find(c => c.id === cardId);
    if (card) card.is_archived = true;
    renderBoard(); 
  }
}

async function unarchiveCardAction(e, cardId) {
  if (e) e.stopPropagation();

  const res = await api('POST', `/cards/${cardId}/unarchive`);
  if (res) {
    toast.success('Карточка восстановлена из архива');
    
    const card = cards.find(c => c.id === cardId);
    if (card) card.is_archived = false;
    renderBoard(); 
  }
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
    delBtn.onclick = () => deleteAttachment(a.id, a.isPending);
 
    item.appendChild(iconSpan);
    item.appendChild(nameEl);
    item.appendChild(dlLink);
    item.appendChild(delBtn);
    list.appendChild(item);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАГРУЗКА ФАЙЛОВ
// ─────────────────────────────────────────────────────────────────────────────
function handleFileDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('drop-zone');
  zone.classList.remove('border-indigo-500', 'bg-indigo-50');
  const files = Array.from(event.dataTransfer.files);
  _processFiles(files);
}

function handleFileInputChange(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  _processFiles(files);
}

async function _processFiles(files) {
  const MAX_SIZE = 10 * 1024 * 1024;
  const ALLOWED  = ['image/', 'application/pdf', 'application/msword',
                    'application/vnd.openxmlformats', 'application/vnd.ms-excel',
                    'text/plain', 'application/zip'];

  const cardId = document.getElementById('card-edit-id').value;

  for (const file of files) {
    if (file.size > MAX_SIZE) {
      toast.warn(`«${file.name}» слишком большой (макс. 5 МБ)`); continue;
    }
    const allowed = ALLOWED.some(t => file.type.startsWith(t));
    if (!allowed) {
      toast.warn(`«${file.name}» — неподдерживаемый тип файла`); continue;
    }

    _addToPending(file);
  }
  _refreshAttachmentsUI();
}

function _refreshAttachmentsUI() {
  const cardId = document.getElementById('card-edit-id').value;
  const card = cards.find(c => c.id === cardId);
  
  const existing = (card?.attachments || []).filter(a => !pendingDeletions.includes(a.id));
  
  const pending = pendingFiles.map((f, index) => ({
    id: `pending-${index}`,
    filename: f.name,
    isPending: true
  }));

  _renderAttachmentsList([...existing, ...pending]);
}

function _addToPending(file) {
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

async function deleteAttachment(attachmentId, isPending = false) {
  if (isPending) {
    pendingFiles = pendingFiles.filter(f => f.name !== attachmentId);
  } else {
    if (!pendingDeletions.includes(attachmentId)) {
      pendingDeletions.push(attachmentId);
    }
  }

  const cardId = document.getElementById('card-edit-id').value;
  const card = cards.find(c => c.id === cardId);
  const existing = (card?.attachments || []).filter(a => !pendingDeletions.includes(a.id));
  const pending = pendingFiles.map(f => ({ filename: f.name, isPending: true }));
  
  _renderAttachmentsList([...existing, ...pending]);
  toast.success('Вложение помечено на удаление.');
}

function downloadAllAttachments() {
  const cardId = document.getElementById('card-edit-id').value;
  const card = cards.find(c => c.id === cardId);
  if (!card) return;
  _downloadAttachments(card.attachments);
}

// ─────────────────────────────────────────────────────────────────────────────
// SORTING
// ─────────────────────────────────────────────────────────────────────────────
function changeSortMode(mode) {
    currentSortMode = mode;
    _saveUIState();

    if (typeof renderBoard === 'function') {
        renderBoard();
    }
}

function getCardSorted() {
  return (a, b) => {
    if (currentSortMode === 'priority') {
      const weights = {'HIGHT': 2, 'MEDIUM': 1, 'LOW': 0};
      const diff = (weights[b.priority] || 0) - (weights[a.priority] || 0);
      if (diff != 0) return diff;
      return a.position - b.position;
    }

    if (currentSortMode === 'deadline') {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      const diff = new Date(a.deadline) - new Date(b.deadline);
      if (diff !== 0) return diff;
      return a.position - b.position;
    }
    return a.position - b.position;
  }
}

function _saveUIState() {
  const state = {
    sort: currentSortMode,
    filter: currentFilterMode
  };
  sessionStorage.setItem('ui_settings', JSON.stringify(state));
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTERING
// ─────────────────────────────────────────────────────────────────────────────
async function changeFilterMode(mode) {
  currentFilterMode = mode;
  _saveUIState();

  if (typeof renderBoard === 'function') {
    renderBoard();
  }
}

function getCardFilter() {
  const meId = currentUser?.user_id;
  return (card) => {
    if (currentFilterMode === 'archived') {
      return card.is_archived === true;
    }

    if (card.is_archived) {
      return false;
    }

    switch (currentFilterMode){
      case 'all':
        return true;
      case 'my':
        return card.assigned_to === meId;
      case 'created':
        return card.created_by === meId;
      case 'p-high':
        return card.priority === 'HIGHT';
      case 'p-medium':
        return card.priority === 'MEDIUM';
      case 'p-low':
        return card.priority === 'LOW';
    }

    return true;
  }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
function showNotification(payload) {
  const container = _getToastContainer();
  
  const priorityMap = {
    'HIGHT': { color: 'bg-red-500', text: 'Высокий', bg: 'bg-red-50', textColor: 'text-red-700' },
    'MEDIUM': { color: 'bg-amber-500', text: 'Средний', bg: 'bg-amber-50', textColor: 'text-amber-700' },
    'LOW': { color: 'bg-slate-400', text: 'Низкий', bg: 'bg-slate-50', textColor: 'text-slate-600' }
  };
  const p = priorityMap[payload.priority] || priorityMap['LOW'];

  const toast_ = document.createElement('div');
  toast_.className = `pointer-events-auto border border-slate-200 ${p.bg} rounded-xl shadow-xl flex flex-col overflow-hidden animate-slide-in w-72`;

  const topPart = document.createElement('div');
  topPart.className = 'flex flex-1';

  const bar = document.createElement('div');
  bar.className = `${p.color} w-1.5 flex-shrink-0`;

  const body = document.createElement('div');
  body.className = 'px-4 py-3 flex flex-col gap-1 flex-1 min-w-0';

  const header = document.createElement('div');
  header.className = 'flex justify-between items-center';
  
  const label = document.createElement('span');
  label.className = `${p.textColor} font-bold text-[10px] uppercase tracking-widest`;
  label.textContent = `Новая задача • ${p.text}`;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-slate-400 hover:text-slate-600 text-lg leading-none';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => _removeToast(toast_);
  
  header.appendChild(label); 
  header.appendChild(closeBtn);

  const titleEl = document.createElement('div');
  titleEl.className = 'text-slate-800 font-semibold text-sm';
  titleEl.textContent = payload.card_title || 'Без названия';

  const fromEl = document.createElement('div');
  fromEl.className = 'text-slate-500 text-xs';
  fromEl.textContent = 'Назначил: ';
  const fromName = document.createElement('span');
  fromName.className = 'font-medium text-slate-700';
  fromName.textContent = payload.from_user || 'Система';
  fromEl.appendChild(fromName);

  body.appendChild(header); 
  body.appendChild(titleEl); 
  body.appendChild(fromEl);
  topPart.appendChild(bar); 
  topPart.appendChild(body);
  toast_.appendChild(topPart);

  const actions = document.createElement('div');
  actions.className = 'px-4 pb-3 flex flex-col gap-2';

  const btnShow = document.createElement('button');
  btnShow.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold py-2 rounded-lg transition-colors shadow-sm';
  btnShow.textContent = 'Показать мои задачи';
  btnShow.onclick = () => {
    const fSelect = document.getElementById('filter-select');
    if (fSelect) fSelect.value = 'my';
    _removeToast(toast_);
  };

  actions.appendChild(btnShow);
  toast_.appendChild(actions);

  container.appendChild(toast_);

  setTimeout(() => {
    if (toast_.parentElement) _removeToast(toast_);
  }, 6000);
}

async function showOfflineNotification() {
  const container = _getToastContainer();
  const t = document.createElement('div');
  t.className = 'pointer-events-auto border-2 border-indigo-400 bg-indigo-50 rounded-xl shadow-2xl p-4 animate-bounce-in flex flex-col gap-3 w-72';
 
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
  t.appendChild(row);

  const actions = document.createElement('div');
  actions.className = 'flex flex-col gap-2';

  const btnShow = document.createElement('button');
  btnShow.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold py-2 rounded-lg transition-colors';
  btnShow.textContent = 'Показать мои задачи';
  btnShow.onclick = async () => {
    await api('DELETE', '/notifications/clear');
    const fSelect = document.getElementById('filter-select');
    if (fSelect) fSelect.value = 'my';
    await changeFilterMode('my');
    _removeToast(t);
  };
 
  const btnOk = document.createElement('button');
  btnOk.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 rounded-lg transition-colors';
  btnOk.textContent = 'Понятно, спасибо!';
  btnOk.onclick = async () => {
    await api('DELETE', '/notifications/clear');

    if (currentUser && currentUser.user_id) {
      const allCards = document.querySelectorAll('.card');
      allCards.forEach(cardEl => {
        const cardId = cardEl.dataset.cardId;
        const cardData = cards.find(c => String(c.id) === String(cardId));
        
        if (cardData && cardData.assigned_to === currentUser.user_id) {
          cardEl.classList.add('ring-4', 'ring-emerald-400', 'shadow-emerald-200');
          
          setTimeout(() => {
            cardEl.classList.remove('ring-4', 'ring-emerald-400', 'shadow-emerald-200');
          }, 2000);
        }
      });
    }

    _removeToast(t);
  };
 
  actions.appendChild(btnShow);
  actions.appendChild(btnOk);
  t.appendChild(actions);
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
function _isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function _initBoardSortable() {
  const touch = _isTouchDevice();
  if (currentFilterMode === 'archived') return;
  boardSortable = Sortable.create(document.getElementById('board'), {
    animation: 200,
    handle: '.col-handle',
    ghostClass: 'col-ghost',
    dragClass: 'col-drag',
    chosenClass: 'col-chosen',
    disabled: !currentUser,
    forceFallback: true,
    fallbackClass: 'col-drag',
    fallbackOnBody: true,
    fallbackTolerance: 3,
    delay: touch ? 200 : 0,
    delayOnTouchOnly: true,
    touchStartThreshold: 4,
    swapThreshold: 0.65,
    delay: touch ? 100 : 0,
    touchStartThreshold: 10,
    delayOnTouchOnly: true,

    scroll: true,
    scrollSensitivity: 100,
    scrollSpeed: 20,
    bubbleScroll: true,

    async onStart(evt) {
      isDragging = true;
      document.body.classList.add('dragging-active');
    },

    async onEnd(evt) {
      isDragging = false;
      document.body.classList.remove('dragging-active');
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
        await loadBoard();
      }
    },
  });
}
 
function _initCardSortable(columnId) {
  const listEl = document.querySelector(`.card-list[data-col-id="${columnId}"]`);
  if (!listEl) return;
  let srcColId = null, cardId = null, throttle = null;
 
  const touch = _isTouchDevice();
  const s = Sortable.create(listEl, {
    group: 'cards',
    animation: 150,
    ghostClass: 'card-ghost',
    dragClass: 'card-drag',
    chosenClass: 'card-chosen',
    disabled: !currentUser || currentFilterMode === 'archived',
    forceFallback: true,     
    fallbackClass: 'card-drag',
    fallbackOnBody: true,
    fallbackTolerance: 5,
    delay: touch ? 200 : 0,
    delayOnTouchOnly: true,
    touchStartThreshold: 4,
    swapThreshold: 0.65,
    bubbleScroll: true,
    invertSwap: true,
    delay: touch ? 100 : 0,
    touchStartThreshold: 10,
    delayOnTouchOnly: true,

    scroll: true,
    scrollSensitivity: 100,
    scrollSpeed: 20,
    bubbleScroll: true,

    onStart(e) {
      document.body.classList.add('dragging-active');
      cardId = e.item.dataset.cardId; 
      srcColId = e.item.dataset.colId; 
      isDragging = true;
    },

    onUnchoose(e) {
        e.item.style.width = '';
    },
 
    onMove(e) {
      if (!cardId || !currentUser) return;
      if (throttle) return;
      throttle = setTimeout(() => { throttle = null; }, 80);
      _sendDragEvent(cardId, srcColId, e.to.dataset.colId,
        Math.max(0, Array.from(e.to.children).indexOf(e.related)));
    },
 
    async onEnd(e) {
      isDragging = false;
      document.body.classList.remove('dragging-active');
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
  const lowPriorityRadio = document.querySelector('input[name="card-priority"][value="LOW"]');
  if (lowPriorityRadio) lowPriorityRadio.checked = true;

  const listContainer = document.getElementById('main-comments-section');
  listContainer.classList.add('hidden');

  clearDeadline();
  pendingFiles = [];
  _renderPendingList();
  document.getElementById('modal-card').showModal();
  setTimeout(() => document.getElementById('card-title-input').focus(), 50);
}
 
async function openEditCard(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (!card) return;

  const isArchived = card.is_archived || currentFilterMode === 'archived';

  document.getElementById('modal-card-title').textContent = isArchived ? '📦 Просмотр (архив)' : 'Edit Card';
  document.getElementById('card-edit-id').value = cardId;
  document.getElementById('card-col-id').value = card.column_id;
  document.getElementById('card-title-input').value = card.title;
  document.getElementById('card-desc-input').value = card.description || '';
  document.getElementById('card-assign-search').value = card.assigned_to_username || '';
  document.getElementById('card-assign-id').value = card.assigned_to || '';

  // Режим только-чтение для архива
  const editableFields = [
    'card-title-input', 'card-desc-input', 'card-assign-search',
    'card-deadline-input'
  ];
  editableFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = isArchived;
  });
  document.querySelectorAll('input[name="card-priority"]').forEach(r => { r.disabled = isArchived; });
  document.querySelectorAll('[onclick^="setDeadlinePreset"], [onclick="clearDeadline()"]').forEach(b => {
    b.style.display = isArchived ? 'none' : '';
  });
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) dropZone.style.display = isArchived ? 'none' : '';
  const commentInput = document.querySelector('#comments-section .relative.group');
  if (commentInput) commentInput.style.display = isArchived ? 'none' : '';

  const commentField = document.getElementById('card-new-comment');
  if (commentField) commentField.value = '';

  const saveBtn = document.querySelector('#modal-card button[onclick="submitCard()"]');
  if (saveBtn) saveBtn.style.display = isArchived ? 'none' : '';

  const priority = card.priority || "LOW";
  const radioToSelect = document.querySelector(`input[name="card-priority"][value="${priority}"]`);
  if (radioToSelect) radioToSelect.checked = true;

  const dlInput = document.getElementById('card-deadline-input');
  dlInput.value = card.deadline ? _toDatetimeLocal(card.deadline) : '';
  _updateDeadlineClearBtn();
  document.getElementById('deadline-error').classList.add('hidden');
  pendingFiles = [];
  pendingDeletions = [];
  _renderAttachmentsList(card.attachments || []);

  lastCommentId = null;
  commentsHasMore = true;
  isLoadingComments = true;

  const listSection = document.getElementById('main-comments-section');
  const listContainer = document.getElementById('comments-list');
  const listLabel = document.getElementById('comments-label');

  listSection.classList.remove('hidden');
  listContainer.innerHTML = '';

  switchCardTab('comments');
  refreshCommentsUI();

  listContainer.classList.add('hidden');
  listLabel.classList.add('hidden');
  listLabel.textContent = 'Комментарии';

  document.getElementById('modal-card').showModal();

  try {
    const data = await api('GET', `/cards/${cardId}/comments`, undefined, true);
    if (data && data.length > 0) {
      listLabel.textContent = 'Комментарии';
      listLabel.classList.remove('hidden');
      listContainer.classList.remove('hidden');

      const chronological = [...data].reverse();
      _renderCommentsBatch(chronological, false);
      refreshCommentsUI();

      lastCommentId = data[data.length - 1].id;
      if (data.length < COMMENTS_LIMIT) commentsHasMore = false;


      requestAnimationFrame(() => {
        listContainer.style.scrollBehavior = 'auto';
        listContainer.scrollTop = listContainer.scrollHeight;
      });
    } else {
      listLabel.textContent = 'Нет комментариев';
      listLabel.classList.remove('hidden');
      listContainer.classList.add('hidden');
      commentsHasMore = false;
    }
  } finally {
    isLoadingComments = false;
  }
}

let lastSubmitTime = 0;
async function submitCard() {
  if (currentFilterMode === 'archived') {
    toast.warn('В режиме архива редактирование недоступно');
    return;
  }

  const now = Date.now();
    
    if (now - lastSubmitTime < 2000) {
        console.warn("Слишком быстрый повторный клик игнорирован");
        return;
    }

  const btn = document.querySelector('#modal-card button[onclick="submitCard()"]');
  if (!btn || btn.disabled) return;

  lastSubmitTime = now;

  const originalOnClick = btn.onclick;
  btn.onclick = null; 
  btn.disabled = true;

  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="animate-spin inline-block mr-2">↻</span> Сохранение...';

  try {
    const editId     = document.getElementById('card-edit-id').value;
    const colId      = document.getElementById('card-col-id').value;
    const title      = document.getElementById('card-title-input').value.trim();
    const desc       = document.getElementById('card-desc-input').value.trim();
    const assigneeId = document.getElementById('card-assign-id').value.trim() || null;

    if (!title) return toast.warn('Заголовок обязателен');
    if (!_colNameRe.test(title)) return toast.warn('Название: только буквы, цифры и пробелы');


    const deadlineRaw = document.getElementById('card-deadline-input').value;
    let deadline = null;
    if (deadlineRaw) {
      deadline = _validateDeadline();
      if (deadline === false) {
        toast.error('Дедлайн должен быть позже текущего времени');
        return;
      }
    }

    const priorityElement = document.querySelector('input[name="card-priority"]:checked');
    const priority = priorityElement ? priorityElement.value : 'LOW';

    const payload = { title, description: desc || null, assigned_to: assigneeId, deadline, priority };

  let result;
    if (editId) {
      if (pendingDeletions.length > 0) {
        for (const attachId of pendingDeletions) {
          await api('DELETE', `/cards/attachments/${attachId}`);
        }
      }
      result = await api('PUT', `/cards/${editId}`, payload);
    } else {
      result = await api('POST', '/cards', {
        ...payload, column_id: colId, created_by: currentUser.user_id,
      });
    }

    if (result) {    
      document.getElementById('modal-card').close();

      const matches = getCardFilter()(result);
      if (!matches && !editId) {
        toast.info('Карточка создана, но скрыта текущим фильтром', 5000);
      }
      
      if (result && result.id && pendingFiles.length > 0) {
        await _flushPendingFiles(result.id); 
      }
      
      pendingFiles = [];
      pendingDeletions = [];
      
      renderBoard();
    }

  } catch (error) {
    console.error('Ошибка при сохранении карточки или вложений:', error);
    toast.error('Произошла ошибка при сохранении');
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.onclick = originalOnClick;
        btn.innerHTML = originalText;
        lastSubmitTime = 0; 
      }
    }, 1000);
  }
}
 
async function deleteCard(id) {
  if (!confirm('Удалить карточку?')) return;
  await api('DELETE', `/cards/${id}`);
}

function refreshCommentsUI() {
    const listContainer = document.getElementById('comments-list');
    const listLabel = document.getElementById('comments-label');
    if (!listContainer || !listLabel) return;

    const count = listContainer.querySelectorAll('.comment-item').length;

    if (count > 0) {
        listLabel.textContent = 'Комментарии';
        listLabel.classList.remove('hidden');
        listContainer.classList.remove('hidden');
        listContainer.style.display = 'block';
    } else {
        listLabel.textContent = 'Нет комментариев';
        listLabel.classList.remove('hidden');
        listContainer.classList.add('hidden');
        listContainer.style.display = 'none';
    }
}

function switchCardTab(tab) {
  const isComm = tab === 'comments';
  const commSection = document.getElementById('comments-section');
  const histSection = document.getElementById('history-section');
  const cBtn = document.getElementById('tab-link-comments');
  const hBtn = document.getElementById('tab-link-history');

  if (commSection) commSection.classList.toggle('hidden', !isComm);
  if (histSection) histSection.classList.toggle('hidden', isComm);
  
  if (cBtn && hBtn) {
    const activeClass = "text-indigo-600 border-indigo-600";
    const inactiveClass = "text-slate-400 border-transparent hover:text-slate-600";
    
    cBtn.className = `text-xs font-bold uppercase tracking-wide pb-1 border-b-2 ${isComm ? activeClass : inactiveClass}`;
    hBtn.className = `text-xs font-bold uppercase tracking-wide pb-1 border-b-2 ${!isComm ? activeClass : inactiveClass}`;
  }

  if (!isComm) {
    lastEventId = null;
    historyHasMore = true;
    const cardId = document.getElementById('card-edit-id').value;
    if (cardId) loadCardHistory(cardId);
  }
}

async function loadCardHistory(cardId, isLoadMore = false) {
  const list = document.getElementById('card-history-list');
  if (!list || isLoadingHistory || (!isLoadMore && !historyHasMore)) return;

  if (!isLoadMore) {
    list.innerHTML = '<div id="history-loading-spinner" class="text-center py-4 text-slate-400 animate-pulse text-[10px]">Загрузка истории...</div>';
    lastEventId = null;
    historyHasMore = true;
  } else {
    const loader = document.createElement('div');
    loader.id = 'history-more-loader';
    loader.className = 'text-center py-2 text-[10px] text-slate-400 italic';
    loader.innerText = 'Загрузка более старых событий...';
    list.appendChild(loader);
  }

  isLoadingHistory = true;

  try {
    let url = `/events?card_id=${cardId}&limit=${EVENTS_LIMIT}`;
    if (lastEventId) url += `&last_id=${lastEventId}`;

    const events = await api('GET', url);

    document.getElementById('history-loading-spinner')?.remove();
    document.getElementById('history-more-loader')?.remove();
    
    if (!events || events.length === 0) {
      list.innerHTML = '<div class="text-center py-4 text-slate-400 italic text-[10px]">История событий пуста</div>';
      historyHasMore = false;
      return;
    }

    const html = events.map(ev => {
      let cfg = {
        border: "border-slate-200",
        bg: "bg-slate-50",
        text: "text-slate-600",
        icon: "📋"
      };

      switch (ev.event_type) {
        case 'CARD_CREATED':
          cfg = { border: "border-green-300", bg: "bg-green-50", text: "text-green-700", icon: "✨" };
          break;
        case 'CARD_MOVED':
          cfg = { border: "border-blue-300", bg: "bg-blue-50", text: "text-blue-700", icon: "🚀" };
          break;
        case 'COMMENT_ADDED':
        case 'COMMENT_EDITED':
          cfg = { border: "border-indigo-300", bg: "bg-indigo-50", text: "text-indigo-700", icon: "💬" };
          break;
        case 'CARD_ARCHIVED':
          cfg = { border: "border-amber-300", bg: "bg-amber-50", text: "text-amber-700", icon: "📦" };
          break;
        case 'ATTACHMENT_ADDED':
          cfg = { border: "border-purple-300", bg: "bg-purple-50", text: "text-purple-700", icon: "📎" };
          break;
        case 'CARD_DELETED':
        case 'COMMENT_DELETED':
          cfg = { border: "border-red-300", bg: "bg-red-50", text: "text-red-700", icon: "🗑️" };
          break;
      }

      const username = ev.user ? ev.user.username : 'Система';

      return `
        <div class="mb-2 p-2 rounded border-l-4 ${cfg.border} ${cfg.bg} shadow-sm">
          <div class="flex justify-between items-center mb-1 text-[9px]">
            <span class="font-bold ${cfg.text} uppercase tracking-wider flex items-center">
              <span class="mr-1">${cfg.icon}</span> ${esc(username)}
            </span>
            <span class="text-slate-400 font-medium">${new Date(ev.created_at).toLocaleString()}</span>
          </div>
          <div class="text-[11px] ${cfg.text} leading-snug pl-4">
            ${esc(ev.message)}
          </div>
        </div>
      `;
    }).join('');
    if (isLoadMore) {
      list.insertAdjacentHTML('beforeend', html);
    } else {
      list.innerHTML = html;
    }

    lastEventId = events[events.length - 1].id;
    if (events.length < EVENTS_LIMIT) {
      historyHasMore = false;
    }
  } catch (err) {
    console.error("History load error:", err);
    if (!isLoadMore) list.innerHTML = '<div class="text-center py-4 text-red-400 text-[10px]">Ошибка загрузки</div>';
  } finally {
    isLoadingHistory = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEZY COMMENTS LOGIC
// ─────────────────────────────────────────────────────────────────────────────
async function loadMoreComments(cardId) {
  if (isLoadingComments || !commentsHasMore) return;
  isLoadingComments = true;
  const listContainer = document.getElementById('comments-list');

  const oldScrollHeight = listContainer.scrollHeight;
  const oldScrollTop = listContainer.scrollTop;

  try {
    const data = await api('GET', `/cards/${cardId}/comments?last_id=${lastCommentId}`, undefined, true);

    if (data && data.length > 0) {
      if (data.length < COMMENTS_LIMIT) {
        commentsHasMore = false;
      }
      
      const chronological = [...data].reverse();
      _renderCommentsBatch(chronological, true);
      
      lastCommentId = data[data.length - 1].id; 

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          listContainer.scrollTop = oldScrollTop + (listContainer.scrollHeight - oldScrollHeight);
        });
      });
    } else {
      commentsHasMore = false;
    }
  } finally {
    isLoadingComments = false;
  }
}

function _renderCommentsBatch(batch, isPrepend = false) {
  const container = document.getElementById('comments-list');
  if (!container) return;

  const html = batch.map(comment => {
    const date = new Date(comment.created_at).toLocaleString([], {
        day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    });
    const authorName = (comment.author && comment.author.username) 
                           || comment.username 
                           || 'Аноним';

    const authorId = comment.user_id || (comment.author && comment.author.id);
    const isMyComment = currentUser && String(authorId) === String(currentUser.user_id);
    
    return `
      <div class="comment-item bg-white p-3 rounded-lg border border-slate-100 shadow-sm group" data-id="${comment.id}">
        <div class="flex justify-between items-center mb-1">
          <div class="flex items-center gap-2">
            <span class="font-bold text-xs text-indigo-600">${esc(authorName)}</span>
            <span class="text-[10px] text-slate-400">${date}</span>
          </div>
          
          ${isMyComment ? `
          <div id="update-comment" class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onclick="prepareEditComment('${comment.id}')" class="p-1 text-slate-400 hover:text-indigo-600 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
            </button>
            <button onclick="deleteCommentAction('${comment.id}')" class="p-1 text-slate-400 hover:text-red-600 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
          ` : ''}
        </div>
        <div class="comment-content text-sm text-slate-700 whitespace-pre-wrap break-words">${esc(comment.text)}</div>
      </div>
    `;
  }).join('');

  if (isPrepend) {
    container.insertAdjacentHTML('afterbegin', html);
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

async function addCommentAction() {
  const cardId = document.getElementById('card-edit-id').value;
  const input = document.getElementById('card-new-comment');
  const text = input.value.trim();

  if (!cardId || !text) return;

  const res = await api('POST', `/cards/${cardId}/comments`, {text});
  if (res) {
    input.value = '';

    const newCommentForUI = {
        ...res,
        author: res.author || { username: currentUser.username }
    };

    refreshCommentsUI();

    const list = document.getElementById('comments-list');
    list.scrollTo({top: list.scrollHeight, behavior: 'smooth'});
  }
}

async function deleteCommentAction(commentId) {
  if (!confirm('Удалить этот комментарий')) return;

  try {
    const res = await api('DELETE', `/cards/comment/${commentId}`)
    const el = document.querySelector(`.comment-item[data-id="${commentId}"]`);
    if (el) {
      el.remove();
      refreshCommentsUI();
    };
    toast.success('Комментарий удален')
  } catch (err) {
    toast.error('Не удалось удалить комментарий')
  }
}

function prepareEditComment(commentId) {
  const item = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  const contentDiv = item.querySelector('.comment-content');
  const oldText = contentDiv.innerText;

  const btnEd = document.getElementById('update-comment')
  btnEd.classList.add('hidden')

  contentDiv.innerHTML = `
    <textarea class="edit-comment-area w-full p-2 border border-indigo-300 rounded-md text-sm focus:outline-none resize-none no-scrollbar">${esc(oldText)}</textarea>
    <div class="flex justify-end gap-2 mt-2">
      <button onclick="cancelEditComment('${commentId}', \`${esc(oldText)}\`)" class="text-[10px] text-slate-500 hover:underline">Отмена</button>
      <button onclick="saveEditComment('${commentId}')" class="text-[10px] text-indigo-600 font-bold hover:underline">Сохранить</button>
    </div>
  `;
  
  const textarea = contentDiv.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function cancelEditComment(commentId, oldText) {
  const item = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  item.querySelector('.comment-content').innerText = oldText;

  const btnEd = document.getElementById('update-comment')
  btnEd.classList.remove('hidden')
}

async function saveEditComment(commentId) {
  const item = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  const textarea = item.querySelector('.edit-comment-area');
  const newText = textarea.value.trim();

  const btnEd = document.getElementById('update-comment')
  btnEd.classList.add('hidden')

  if (!newText) return;

  try {
    const res = await api('PATCH', `/cards/comments/${commentId}`, { text: newText });
    
    if (res) {
      item.querySelector('.comment-content').innerText = res.text;
      toast.success('Изменено');
    }
  } catch (err) {
    toast.error('Ошибка при сохранении');
  }
}

function toggleEmojiPicker() {
  let picker = document.getElementById('emoji-picker');
  
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'emoji-picker';
    picker.className = 'absolute bottom-full right-0 mb-2 bg-white border border-slate-200 shadow-xl rounded-lg p-2 grid grid-cols-6 gap-1 z-50';
    
    const emojis = ['👍', '❤️', '🔥', '✅', '🚀', '⭐', '👀', '🙌', '💡', '🤔', '❌', '💯'];
    
    picker.innerHTML = emojis.map(e => `
      <button type="button" onclick="insertEmoji('${e}')" 
              class="hover:bg-slate-100 p-1.5 rounded text-lg transition-colors">
        ${e}
      </button>
    `).join('');
  
    const btn = event.currentTarget;
    btn.parentElement.classList.add('relative');
    btn.parentElement.appendChild(picker);
  } else {
    picker.classList.toggle('hidden');
  }

  const closePicker = (e) => {
    if (!picker.contains(e.target) && e.target !== document.querySelector('[onclick="toggleEmojiPicker()"]')) {
      picker.classList.add('hidden');
      document.removeEventListener('click', closePicker);
    }
  };
  
  if (!picker.classList.contains('hidden')) {
    setTimeout(() => document.addEventListener('click', closePicker), 10);
  }
}

function insertEmoji(emoji) {
  const input = document.getElementById('card-new-comment');
  if (input) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = input.value;
    input.value = text.substring(0, start) + emoji + text.substring(end);
    
    input.focus();
    input.setSelectionRange(start + emoji.length, start + emoji.length);
  }
  
  document.getElementById('emoji-picker')?.classList.add('hidden');
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

  const commentList = document.getElementById('comments-list');
  if (commentList) {
    commentList.addEventListener('scroll', () => {
      const triggerThreshold = 400; 
      if (commentList.scrollTop < triggerThreshold && commentsHasMore && !isLoadingComments) {
        const cardId = document.getElementById('card-edit-id').value;
        if (cardId) {
          loadMoreComments(cardId);
        }
      }
    });
  }

  window.addEventListener('keydown', async (e) => {
      const isTyping = ['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
      
      const activeModal = document.querySelector('dialog[open]');

      if (isTyping || activeModal || isDragging) {
          return;
      }

      if (e.code === 'Space') {
          if (e.repeat) return;
          
          e.preventDefault(); 

          const now = Date.now();
          if (now - (window.lastSpacePress || 0) < 300) {
              const newMode = (currentFilterMode === 'my') ? 'all' : 'my';
              
              const filterSelect = document.getElementById('filter-select');
              if (filterSelect) filterSelect.value = newMode;
              
              await changeFilterMode(newMode);
              
              toast.info(newMode === 'my' ? "Режим: Только мои задачи" : "Режим: Все задачи");
              
              window.lastSpacePress = 0;
              return;
          }
          window.lastSpacePress = now;
      }

      if (e.code === 'KeyA') {
          if (e.repeat) return;

          const now = Date.now();
          if (now - (window.lastAPress || 0) < 300) {
              e.preventDefault();
              
              const newMode = (currentFilterMode === 'archived') ? 'all' : 'archived';
              await changeFilterMode(newMode);
              
              const fSelect = document.getElementById('filter-select');
              if (fSelect) fSelect.value = newMode;

              toast.info(newMode === 'archived' ? 'Режим: Архив' : 'Режим: Все задачи');
              
              window.lastAPress = 0;
              return;
          }
          window.lastAPress = now;
      }
  });

  const historyContainer = document.getElementById('card-history-list');
  if (historyContainer) {
      historyContainer.addEventListener('scroll', () => {
          if (historyContainer.scrollTop + historyContainer.clientHeight >= historyContainer.scrollHeight - 20) {
              const cardId = document.getElementById('card-edit-id')?.value;
              if (cardId && historyHasMore && !isLoadingHistory) {
                  loadCardHistory(cardId, true);
              }
          }
      });
  }

  const savedUI = sessionStorage.getItem('ui_settings');
  if (savedUI) {
    try {
      const { sort, filter } = JSON.parse(savedUI);
      currentSortMode = sort || 'position';
      currentFilterMode = filter || 'all';
      
      const sSelect = document.getElementById('sort-select');
      const fSelect = document.getElementById('filter-select');
      if (sSelect) sSelect.value = currentSortMode;
      if (fSelect) fSelect.value = currentFilterMode;
    } catch (e) {
      console.warn("Ошибка восстановления настроек UI");
    }
  }

  const me = await api('GET', '/users/me', undefined, true);

  try {
    if (me && me.user_id) {
      currentUser = me;
      await _uiLoggedIn(me);

      const cachedData = sessionStorage.getItem('last_board_state');
      if (cachedData) {
        try {
          const data = JSON.parse(cachedData);
          columns = data.columns || [];
          cards = data.cards || [];
          onlineUsers = data.online_users || [];
          
          renderBoard();
          if (typeof _renderOnlineUsers === 'function') _renderOnlineUsers();
        } catch (e) {
          console.warn("Кеш пуст или поврежден");
        }
      }

      await loadBoard();
    } else {
      sessionStorage.removeItem('last_board_state');
      _uiLoggedOut();
    }
  } catch (err) {
    _uiLoggedOut();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.tagName !== 'DIALOG') return;
  const r = e.target.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) e.target.close();
});

document.addEventListener('DOMContentLoaded', () => {
  const modalCard = document.getElementById('modal-card');
  if (modalCard) {
    modalCard.addEventListener('close', () => {
      const fields = ['card-title-input','card-desc-input','card-assign-search','card-deadline-input'];
      fields.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
      document.querySelectorAll('input[name="card-priority"]').forEach(r => { r.disabled = false; });
      document.querySelectorAll('[onclick^="setDeadlinePreset"], [onclick="clearDeadline()"]').forEach(b => { b.style.display = ''; });
      const dropZone = document.getElementById('drop-zone');
      if (dropZone) dropZone.style.display = '';
      const commentInput = document.querySelector('#comments-section .relative.group');
      if (commentInput) commentInput.style.display = '';
      const saveBtn = document.querySelector('#modal-card button[onclick="submitCard()"]');
      if (saveBtn) saveBtn.style.display = '';
    });
  }
});