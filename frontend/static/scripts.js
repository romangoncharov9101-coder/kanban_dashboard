const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

API = window.location.origin + '/api';

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
const cardSortables = new Map();
 
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
        const errMsg = json.error || json.message || `Error: ${res.status}`;
        alert(errMsg); 
      }
      return null;
  }

  return json;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// LOG
// ─────────────────────────────────────────────────────────────────────────────
function logEvent(type, msg) {
  const colors = {
    card_created:'text-green-600', card_updated:'text-blue-600',
    card_moved:'text-purple-600',  card_deleted:'text-red-500',
    card_dragging:'text-amber-500',
    column_created:'text-green-700', column_updated:'text-blue-700', column_deleted:'text-red-600',
    user_online:'text-emerald-600', user_offline:'text-gray-400',
    session_invalidated:'text-orange-500',
    error:'text-red-700', system:'text-gray-500',
  };
  const el = document.getElementById('event-log');
  if (!el) return;
  el.insertAdjacentHTML('afterbegin',
    `<div class="${colors[type] || 'text-gray-600'}">[${new Date().toLocaleTimeString()}] <b>${type}</b> ${esc(String(msg).substring(0, 120))}</div>`);
  while (el.children.length > 100) el.lastChild.remove();
}
function clearLog() { document.getElementById('event-log').innerHTML = ''; }
 
// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
const _usernameRe = /^[a-zA-Zа-яА-ЯёЁ]{1,100}$/;
const _colNameRe  = /^[a-zA-Zа-яА-ЯёЁ0-9\s]{1,100}$/;
const _cardTitleRe = /^[a-zA-Zа-яА-ЯёЁ0-9\s.,!?\-_]{1,200}$/;
 
async function doRegister() {
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value;
  if (!_usernameRe.test(u)) return alert('Никнейм: только буквы, 1–100 символов');
  if (p.length < 6) return alert('Пароль: минимум 6 символов');
  const d = await api('POST', '/users/register', { username: u, password: p });
  if (!d) return;
  await _uiLoggedIn(d);
  await loadBoard();
}
 
async function doLogin() {
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value;
  if (!u || !p) return alert('Введите логин и пароль');
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
    const status = await api('GET', '/notifications/check');
    if (status && status.has_new_tasks) {
      showOfflineNotification();
    }
  } catch(e) {
    logEvent('error', 'Could not check notifications:');
  }

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
    const jitter = (_wsRetryDelay * 0.2) * (Math.random() * 2 - 1);
    wsTimer = setTimeout(connectWS, _wsRetryDelay + jitter);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, _wsMaxDelay);
  };
 
  ws.onerror = () => logEvent('error', 'WS error — will retry');
 
  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.event === 'card_dragging') { _handleRemoteDrag(msg.payload); return; }
    if (msg.event === 'session_invalidated') {
      if (currentUser && msg.payload?.user_id === currentUser.user_id) {
        logEvent('session_invalidated', 'Сессия завершена на другой вкладке');
        _disconnectWS();
        currentUser = null;
        columns = []; cards = []; onlineUsers = [];
        document.getElementById('board').innerHTML = '';
        document.getElementById('online-users').innerHTML = '';
        _uiLoggedOut();
      }
      return;
    }
 
    if (msg.event === 'notification') { showNotification(msg.payload); return; }
 
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
  if (_reloading) {
    _reloadTimer = setTimeout(_flushReload, 100);
    return;
  }
 
  const events = new Set(_pendingEvents);
  _pendingEvents.clear();
 
  const needsFull    = events.has('user_created');
  const needsColumns = events.has('column_created') || events.has('column_updated') || events.has('column_deleted');
  const needsCards   = events.has('card_created')   || events.has('card_updated')   ||
                       events.has('card_deleted')   || events.has('card_moved');
  const needsOnline  = events.has('user_online')    || events.has('user_offline');
 
  _reloading = true;
  try {
    if (needsFull) {
      await loadBoard();
    } else if (needsColumns && needsOnline) {
      await Promise.all([_loadColumns(), _loadOnlineUsers()]);
    } else if (needsColumns) {
      await _loadColumns();
    } else if (needsCards && needsOnline) {
      await Promise.all([_loadCards(), _loadOnlineUsers()]);
    } else if (needsCards) {
      await _loadCards();
    } else if (needsOnline) {
      await _loadOnlineUsers();
    }
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
// DATA LOADING  — точечные загрузчики вместо одного монолитного loadBoard()
// ─────────────────────────────────────────────────────────────────────────────
async function loadBoard() {
  if (!currentUser) return;
  const [cols, crds, onl] = await Promise.all([
    api('GET', '/columns'),
    api('GET', '/cards'),
    // api('GET', '/users'),
    api('GET', '/users/online'),
  ]);
  if (!cols || !crds || !onl) return;
  columns = cols; cards = crds; onlineUsers = onl;
  // _updateUserSelect();
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
  return `
    <div class="bg-white rounded-xl shadow flex flex-col min-w-[270px] max-w-[270px]"
         data-column-id="${col.id}">
      <div class="col-handle flex justify-between items-center px-4 pt-4 pb-2 border-b border-gray-100 select-none">
        <h3 class="font-semibold text-gray-800 truncate pr-2" title="${esc(col.name)}">${esc(col.name)}</h3>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="text-xs text-gray-400">#${col.position}</span>
          ${ce ? `<button onclick="deleteColumn('${col.id}')" class="text-xs text-red-400 hover:text-red-600" title="Delete">✕</button>` : ''}
        </div>
      </div>
      <div class="card-list px-3 py-2 flex flex-col gap-2 flex-1 min-h-[40px]" data-col-id="${col.id}">
        ${colCards.map(c => _renderCard(c)).join('')}
      </div>
      ${ce ? `<div class="px-3 pb-3">
        <button onclick="openAddCard('${col.id}')"
          class="w-full text-xs text-indigo-600 border border-indigo-200 rounded px-2 py-1.5 hover:bg-indigo-50">+ Card</button>
      </div>` : ''}
    </div>`;
}
 
function _renderCard(c) {
  const creator  = c.created_by_username || '—';
  const assignee = c.assigned_to_username || null;
 
  const displayDate = new Date(c.updated_at || c.created_at).toLocaleString([], {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
 
  return `
    <div class="card bg-white border rounded-lg p-3 text-sm flex flex-col gap-2
                cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
         data-card-id="${c.id}" data-col-id="${c.column_id}"
         onclick="openEditCard('${c.id}')">
      <div class="font-bold text-gray-800 truncate" title="${esc(c.title)}">${esc(c.title)}</div>
      ${c.description ? `<div class="text-gray-500 text-xs line-clamp-2">${esc(c.description)}</div>` : ''}
      <hr class="border-gray-100">
      <div class="space-y-1 text-[11px]">
        <div class="flex justify-between">
          <span class="text-gray-400">Created by</span>
          <span class="font-medium text-gray-600 truncate max-w-[120px]" title="${esc(creator)}">
            ${esc(creator)}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">Assignee</span>
          <span class="truncate max-w-[120px] ${assignee ? 'font-medium text-indigo-600' : 'text-gray-400 italic'}" 
            title="${assignee ? esc(assignee) : 'Unassigned'}">
            ${assignee ? esc(assignee) : 'Unassigned'}
          </span>
        </div>
      </div>
      <div class="flex items-center justify-between pt-1 border-t border-gray-100">
        <span class="text-[10px] text-gray-400">${displayDate}</span>
        ${currentUser ? `
        <div class="flex gap-2" onclick="event.stopPropagation()">
          <button onclick="openEditCard('${c.id}')" title="Edit"
            class="text-blue-400 hover:text-blue-600">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z"/></svg>
          </button>
          <button onclick="deleteCard('${c.id}')" title="Delete"
            class="text-red-400 hover:text-red-600">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>` : ''}
      </div>
    </div>`;
}
 
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
 
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
function showNotification(payload) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-5 right-5 z-[9999] flex flex-col gap-3 pointer-events-none';
    document.body.appendChild(container);
  }
 
  const toast = document.createElement('div');
  toast.className = 'pointer-events-auto bg-white border-l-4 border-indigo-600 shadow-2xl rounded-r-lg p-4 min-w-[300px] max-w-sm animate-slide-in flex flex-col gap-1';
 
  const header = document.createElement('div');
  header.className = 'flex justify-between items-center';
 
  const label = document.createElement('span');
  label.className = 'text-indigo-600 font-bold text-[10px] uppercase tracking-widest';
  label.textContent = 'Новая задача';
 
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-gray-400 hover:text-gray-600 text-lg';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => toast.remove();
 
  header.appendChild(label);
  header.appendChild(closeBtn);
 
  const titleEl = document.createElement('div');
  titleEl.className = 'text-gray-800 font-semibold text-sm';
  titleEl.textContent = payload.card_title || '';
 
  const fromEl = document.createElement('div');
  fromEl.className = 'text-gray-500 text-xs mt-1';
  fromEl.textContent = 'Назначил: ';
  const fromName = document.createElement('span');
  fromName.className = 'font-medium text-gray-700';
  fromName.textContent = payload.from_user || '';
  fromEl.appendChild(fromName);
 
  toast.appendChild(header);
  toast.appendChild(titleEl);
  toast.appendChild(fromEl);
  container.appendChild(toast);
 
  setTimeout(() => {
    toast.style.cssText = 'opacity:0;transition:opacity 0.5s ease';
    setTimeout(() => toast.remove(), 500);
  }, 6000);
}

async function showOfflineNotification() {
  const container = document.getElementById('toast-container') || (() => {
    const c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'fixed top-5 right-5 z-[9999] flex flex-col gap-3';
    document.body.appendChild(c);
    return c;
  })();

  const toast = document.createElement('div');
  toast.className = `
    bg-indigo-50 border-2 border-indigo-500 shadow-2xl rounded-xl p-5 min-w-[320px] 
    animate-bounce-in flex flex-col gap-3 pointer-events-auto
  `;

  toast.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="bg-indigo-500 text-white p-2 rounded-lg">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
      </div>
      <div>
        <h4 class="font-bold text-gray-900 text-sm">Пока вас не было...</h4>
        <p class="text-gray-600 text-xs">Вам были назначены новые задачи!</p>
      </div>
    </div>
    <button id="btn-clear-notif" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 rounded-lg transition-colors">
      Понятно, спасибо!
    </button>
  `;

  container.prepend(toast);

  // Логика нажатия на "ОК"
  toast.querySelector('#btn-clear-notif').onclick = async () => {
    await api('DELETE', '/notifications/clear');
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
    logEvent('system', 'Offline notifications cleared');
  };
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
 
// ─────────────────────────────────────────────────────────────────────────────
// SORTABLEJS: CARDS
// ─────────────────────────────────────────────────────────────────────────────
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
  if (!name) return alert('Название колонки обязательно');
  if (!_colNameRe.test(name)) return alert('Название: только буквы, цифры и пробелы');
  const result = await api('POST', '/columns', { name });
  if (!result) return;
  document.getElementById('modal-add-column').close();
}
 
async function deleteColumn(id) {
  if (!confirm('Удалить колонку? (Она должна быть пустой)')) return;
  await api('DELETE', `/columns/${id}`);
}

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
  document.getElementById('modal-card').showModal();
  setTimeout(() => document.getElementById('card-title-input').focus(), 50);
}
 
async function submitCard() {
  const editId     = document.getElementById('card-edit-id').value;
  const colId      = document.getElementById('card-col-id').value;
  const title      = document.getElementById('card-title-input').value.trim();
  const desc       = document.getElementById('card-desc-input').value.trim();
  // const assigneeId = document.getElementById('card-assign-select').value || null;
  const assigneeId = document.getElementById('card-assign-id').value.trim() || null;

 
  if (!title) return alert('Заголовок обязателен');
 
  const payload = { title, description: desc || null, assigned_to: assigneeId };
 
  let result;
  if (editId) {
    result = await api('PUT', `/cards/${editId}`, payload);
  } else {
    result = await api('POST', '/cards', {
      ...payload, column_id: colId, created_by: currentUser.user_id,
    });
  }
  if (result) document.getElementById('modal-card').close();
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