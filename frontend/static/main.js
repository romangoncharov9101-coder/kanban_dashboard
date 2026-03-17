// const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
//     ? 'http://localhost:8000'
//     : `http://${window.location.hostname}:8000`;

// Автоматически подстраиваемся под текущий хост и протокол
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Базовый URL для API
const API = isLocal 
    ? 'http://localhost:8000' 
    : `${window.location.protocol}//${window.location.host}`;

// Базовый URL для WebSocket
const WS_BASE = isLocal 
    ? 'ws://localhost:8000' 
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

console.log(isLocal, API, WS_BASE)

// Убираем лишние переменные, используем WS_BASE в connectWS
 
  let currentUser = null;
  let ws = null;
  let columns = [];
  let cards = [];
  let allUsers = [];
 
  // ── Helpers ─────────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    if (res.status === 204) return null;
    const json = await res.json();
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText;
      throw new Error(msg);
    }
    return json;
  }
 
  function logEvent(type, msg) {
    const el = document.getElementById('event-log');
    const colors = {
      card_created: 'text-green-600', card_updated: 'text-blue-600',
      card_moved: 'text-purple-600', card_deleted: 'text-red-500',
      column_created: 'text-green-700', column_updated: 'text-blue-700',
      column_deleted: 'text-red-600', user_online: 'text-emerald-600',
      user_offline: 'text-gray-400', error: 'text-red-700',
    };
    const color = colors[type] || 'text-gray-600';
    const time = new Date().toLocaleTimeString();
    el.insertAdjacentHTML('afterbegin',
      `<div class="${color}">[${time}] <b>${type}</b> ${msg}</div>`);
    // Keep at most 100 entries
    while (el.children.length > 100) el.lastChild.remove();
  }
 
  function clearLog() {
    document.getElementById('event-log').innerHTML = '';
  }
 
  // ── Auth ────────────────────────────────────────────────────────────────────
  async function doLogin() {
    const username = document.getElementById('username-input').value.trim();
    if (!username) return alert('Enter a username');
    try {
      const data = await api('POST', '/users/login', { username });
      currentUser = data;
      document.getElementById('login-area').classList.add('hidden');
      document.getElementById('user-info').classList.remove('hidden');
      document.getElementById('current-username').textContent = username;
      document.getElementById('doLogout').classList.remove('hidden');
      // Reconnect WS authenticated so online/offline tracking works
      await loadBoard();
      connectWS(data.user_id);
      logEvent('user_online', `Logged in as ${username}`);
    } catch (e) {
      alert('Login failed: ' + e.message);
    }
  }

  function doLogout() {
    currentUser = null;

    document.getElementById('login-area').classList.remove('hidden');
    document.getElementById('user-info').classList.add('hidden');
    document.getElementById('doLogout').classList.add('hidden');

    document.getElementById('username-input').value = '';
    connectWS(null);
    logEvent('user_offline', 'You have logged out');
  }
 
  // ── WebSocket ────────────────────────────────────────────────────────────────
  let wsReconnectTimer = null;
 
  function connectWS(userId) {
    // Cancel any pending reconnect timer
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
 
    // Close existing socket without triggering auto-reconnect
    if (ws) {
      document.getElementById('ws-dot').className = 'ws-disconnected';
      document.getElementById('ws-label').textContent = 'Reconnecting…';
      ws.onclose = null;
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }

    if (userId === null && currentUser === null) {
        return; 
    }
 
    const url = userId ? `${WS_BASE}/ws?user_id=${userId}` : `${WS_BASE}/ws`;
    ws = new WebSocket(url);
 
    ws.onopen = () => {
      document.getElementById('ws-dot').className = 'ws-connected';
      document.getElementById('ws-label').textContent = 'Connected';
    };
 
    ws.onclose = () => {
      document.getElementById('ws-dot').className = 'ws-disconnected';
      document.getElementById('ws-label').textContent = 'Reconnecting…';
      // Reconnect after 3s, preserving current user_id if logged in
      wsReconnectTimer = setTimeout(() => connectWS(currentUser?.user_id ?? null), 3000);
    };
 
    ws.onerror = () => logEvent('error', 'WebSocket error — will retry');
 
    ws.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      logEvent(msg.event, JSON.stringify(msg.payload).substring(0, 80));
 
      switch (msg.event) {
        case 'column_created':
        case 'column_updated':
        case 'column_deleted':
          await loadBoard();
          break;
        case 'card_created':
        case 'card_updated':
        case 'card_moved':
        case 'card_deleted':
          await loadCards();
          renderBoard();
          break;
        case 'user_online':
        case 'user_offline':
          await loadAllUsers();
          await loadOnlineUsers();
          renderBoard();
          break;
      }
    };
  }
 
  // ── Data loading ────────────────────────────────────────────────────────────
  async function loadBoard() {
    const [cols, crds, usrs] = await Promise.all([
      api('GET', '/columns'),
      api('GET', '/cards'),
      api('GET', '/users'),
    ]);
    columns = cols;
    cards = crds;
    allUsers = usrs;
    renderBoard();
  }
 
  async function loadCards() {
    cards = await api('GET', '/cards');
  }
 
  async function loadOnlineUsers() {
    const users = await api('GET', '/users/online');
    const el = document.getElementById('online-users');
    el.innerHTML = users.length
      ? users.map(u =>
          `<span class="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-xs">${u.username}</span>`
        ).join('')
      : '<span class="text-gray-400 text-xs">nobody</span>';
  }

  async function loadAllUsers() {
    try {
      const users = await api('GET', '/users');
      const select = document.getElementById('card-assign-select')

      select.innerHTML = '<option value="">-- Unassigned --</option>' + 
            users.map(u => `<option value="${u.user_id}">${esc(u.username)}</option>`).join('');
    } catch (e) {
      console.error('Failed to load users for select', e)
    }
  }
 
  // ── Render ──────────────────────────────────────────────────────────────────
  function renderBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';
    const sorted = [...columns].sort((a, b) => a.position - b.position);
    sorted.forEach(col => {
      const colCards = cards
        .filter(c => c.column_id === col.id)
        .sort((a, b) => a.position - b.position);
      board.insertAdjacentHTML('beforeend', renderColumn(col, colCards));
    });
  }
 
  function renderColumn(col, colCards) {
    const cardHTML = colCards.map(c => renderCard(c)).join('');
    return `
      <div class="bg-white rounded-xl shadow p-4 min-w-[260px] max-w-[260px] flex flex-col gap-3">
        <div class="flex justify-between items-center">
          <h3 class="font-semibold text-gray-800 truncate" title="${esc(col.name)}">${esc(col.name)}</h3>
          <span class="text-xs text-gray-400">#${col.position}</span>
        </div>
        <div class="flex flex-col gap-2 flex-1">
          ${cardHTML}
        </div>
        <div class="flex gap-2 mt-1">
          <button onclick="openAddCard('${col.id}')"
            class="flex-1 text-xs text-indigo-600 border border-indigo-200 rounded px-2 py-1 hover:bg-indigo-50">
            + Card
          </button>
          <button onclick="deleteColumn('${col.id}')"
            class="text-xs text-red-400 border border-red-200 rounded px-2 py-1 hover:bg-red-50">
            Del
          </button>
        </div>
      </div>`;
  }
 
  function renderCard(c) {
    // 1. Ищем имена пользователей по ID
    const creator = allUsers.find(u => u.user_id === c.created_by)?.username || 'Unknown';
    const assignee = c.assigned_to 
        ? (allUsers.find(u => u.user_id === c.assigned_to)?.username || 'Unknown') 
        : 'Unassigned';

    // 2. Логика даты: берем updated_at, если его нет — created_at
    const displayDate = new Date(c.updated_at || c.created_at).toLocaleString([], {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    return `
      <div class="card bg-gray-50 border rounded-lg p-3 text-sm flex flex-col gap-2">
        <div class="font-bold text-gray-800 truncate" title="${esc(c.title)}">${esc(c.title)}</div>
        
        ${c.description ? `<div class="text-gray-500 text-xs line-clamp-2">${esc(c.description)}</div>` : ''}
        
        <hr class="border-gray-200">

        <div class="space-y-1 text-[11px]">
          <div class="flex justify-between">
            <span class="text-gray-400">Created by:</span>
            <span class="font-medium text-gray-600">${esc(creator)}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Assignee:</span>
            <span class="${c.assigned_to ? 'font-medium text-indigo-600' : 'text-gray-400 italic'}">${esc(assignee)}</span>
          </div>
        </div>

        <div class="flex items-center justify-between mt-1 pt-2 border-t border-gray-100">
          <span class="text-[10px] text-gray-400" title="Last update">${displayDate}</span>
          
          <div class="flex gap-2">
            <button onclick="openEditCard('${c.id}')" class="text-blue-500 hover:text-blue-700">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
            </button>
            <button onclick="openMoveCard('${c.id}')"
            class="text-xs text-purple-500 hover:text-purple-700 font-medium">Move</button>
            <button onclick="deleteCard('${c.id}')" class="text-red-400 hover:text-red-600">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </div>
      </div>`;
}
 
  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }
 
  // ── Column actions ──────────────────────────────────────────────────────────
  function openAddColumn() {
    if (!currentUser) {
      alert('Please login to create columns');
      return;
    }
    document.getElementById('new-col-name').value = '';
    document.getElementById('modal-add-column').showModal();
  }
 
  async function submitAddColumn() {
    const name = document.getElementById('new-col-name').value.trim();
    if (!name) return alert('Column name is required');
    try {
      await api('POST', '/columns', { name });
      document.getElementById('modal-add-column').close();
      await loadBoard();
    } catch (e) { alert(e.message); }
  }
 
  async function deleteColumn(id) {
    if (!currentUser) {
      alert('Please login to delete columns');
      return;
    }
    if (!confirm('Delete this column? (Must be empty)')) return;
    try {
      await api('DELETE', `/columns/${id}`);
      await loadBoard();
    } catch (e) { alert(e.message); }
  }
 
  // ── Card actions ────────────────────────────────────────────────────────────
  async function openAddCard(colId) {
    if (!currentUser) return alert('Please login first');
    await loadAllUsers();

    document.getElementById('modal-card-title').textContent = 'New Card';
    document.getElementById('card-edit-id').value = '';
    document.getElementById('card-col-id').value = colId;
    document.getElementById('card-title-input').value = '';
    document.getElementById('card-desc-input').value = '';
    document.getElementById('card-assign-select').value = '';
    document.getElementById('modal-card').showModal();
  }
 
  async function openEditCard(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    await loadAllUsers();

    document.getElementById('modal-card-title').textContent = 'Edit Card';
    document.getElementById('card-edit-id').value = cardId;
    document.getElementById('card-col-id').value = card.column_id;
    document.getElementById('card-title-input').value = card.title;
    document.getElementById('card-desc-input').value = card.description || '';

    document.getElementById('card-assign-select').value = card.assigned_to || '';

    document.getElementById('modal-card').showModal();
  }
 
  async function submitCard() {
    const editId = document.getElementById('card-edit-id').value;
    const colId  = document.getElementById('card-col-id').value;
    const title  = document.getElementById('card-title-input').value.trim();
    const desc   = document.getElementById('card-desc-input').value.trim();
    const assignedTo = document.getElementById('card-assign-select').value;

    if (!title) return alert('Title is required');

    const payload = { 
        title, 
        description: desc || null,
        assigned_to: assignedTo || null
    };
 
    try {
      if (editId) {
        await api('PUT', `/cards/${editId}`, payload);
      } else {
        payload.column_id = colId;
        payload.created_by = currentUser.user_id;
        await api('POST', '/cards', payload);
      }
      document.getElementById('modal-card').close();
      // await loadCards();
      await Promise.all([loadCards(), loadAllUsers()]);
      renderBoard();
    } catch (e) { alert(e.message); }
  }
 
  async function deleteCard(id) {
    if (!currentUser) return alert('Please login first');
    if (!confirm('Delete this card?')) return;
    try {
      await api('DELETE', `/cards/${id}`);
      await loadCards();
      renderBoard();
    } catch (e) { alert(e.message); }
  }
 
  function openMoveCard(cardId) {
    if (!currentUser) {
      alert('Please login to move cards');
      return;
    }
    document.getElementById('move-card-id').value = cardId;
    const select = document.getElementById('move-col-select');
    select.innerHTML = columns.map(c =>
      `<option value="${c.id}">${esc(c.name)}</option>`
    ).join('');
    document.getElementById('move-pos-input').value = '0';
    document.getElementById('modal-move').showModal();
  }
 
  async function submitMove() {
    const cardId = document.getElementById('move-card-id').value;
    const colId  = document.getElementById('move-col-select').value;
    const pos    = parseInt(document.getElementById('move-pos-input').value, 10);
    try {
      await api('POST', `/cards/${cardId}/move`, {
        target_column_id: colId,
        target_position: isNaN(pos) ? 0 : pos,
      });
      document.getElementById('modal-move').close();
      await loadCards();
      renderBoard();
    } catch (e) { alert(e.message); }
  }
 
  // ── Init ────────────────────────────────────────────────────────────────────
  (async () => {
    await loadBoard();
    await loadOnlineUsers();
    // connectWS(null);   // connect immediately — dot goes green before login
  })();