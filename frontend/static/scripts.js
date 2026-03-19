const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

API = window.location.origin + '/api';

const WS_BASE = isLocal 
    ? 'ws://localhost:8000' 
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

let currentUser = null;
let ws = null, wsTimer = null;
let columns = [], cards = [];
const remoteDrags = new Map();
let boardSortable = null;
const cardSortables = new Map();
let allUsers = [];
let isUiLocked = false;

// ── API -----------------------------------------------------------------------
// COOKIE: credentials:'include' — браузер отправляет HttpOnly cookie автоматически.
// Никакого localStorage, никаких Authorization-заголовков.
async function api(method, path, body) {
  const opts = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API+path, opts);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) {
    if (res.status === 401) _uiLoggedOut();
    return null;
  }
  return json;
}

// ── Log -----------------------------------------------------------------------
function logEvent(type, msg) {
  const colors = { card_created:'text-green-600', card_updated:'text-blue-600',
    card_moved:'text-purple-600', card_deleted:'text-red-500', card_dragging:'text-amber-500',
    column_created:'text-green-700', column_updated:'text-blue-700', column_deleted:'text-red-600',
    user_online:'text-emerald-600', user_offline:'text-gray-400', error:'text-red-700' };
  const el = document.getElementById('event-log');
  el.insertAdjacentHTML('afterbegin',
    `<div class="${colors[type]||'text-gray-600'}">[${new Date().toLocaleTimeString()}] <b>${type}</b> ${msg}</div>`);
  while (el.children.length > 100) el.lastChild.remove();
}
function clearLog() { document.getElementById('event-log').innerHTML=''; }

// ── Auth ----------------------------------------------------------------------
async function doRegister() {
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value;
  if (!u||!p) return alert('Enter username and password');
  if (p.length<6) return alert('Password must be at least 6 characters');
  try {
    // COOKIE: сервер отвечает Set-Cookie: session=...; HttpOnly; SameSite=Lax
    const d = await api('POST','/users/register',{username:u,password:p});
    currentUser = {user_id:d.user_id, username:d.username};
    _uiLoggedIn();await loadBoard();await loadAllUsers();await loadOnlineUsers();
    logEvent('user_online',`Registered as ${u}`);
  } catch(e) { alert('Register failed: '+e.message); }
}

async function doLogin() {
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value;
  if (!u||!p) return alert('Enter username and password');
  try {
    const d = await api('POST','/users/login',{username:u,password:p});
    currentUser = {user_id:d.user_id, username:d.username};
    _uiLoggedIn();await loadBoard();await loadAllUsers();await loadOnlineUsers();
    logEvent('user_online',`Logged in as ${u}`);
  } catch(e) { alert('Login failed: '+e.message); }
}

async function doLogout() {
  try {
    await api('POST', '/users/logout');
  } catch (e) {
    console.error("Logout API failed", e);
  } finally {
    currentUser = null;
    columns = [];
    cards = [];
    allUsers = [];
    onlineUsers = [];

    if (ws) {
      ws.close();
      ws = null;
    }
    const boardEl = document.getElementById('board');
    if (boardEl) boardEl.innerHTML = '';
    
    const onlineListEl = document.getElementById('online-users');
    if (onlineListEl) onlineListEl.innerHTML = '';

    // 4. Показываем форму входа
    _uiLoggedOut();
    
    logEvent('system', 'Logged out and data cleared');
  }
}

function _uiLoggedIn() {
  document.getElementById('auth-area').classList.add('hidden');
  const ui = document.getElementById('user-info');
  ui.classList.remove('hidden'); ui.classList.add('flex');
  document.getElementById('current-username').textContent = currentUser.username;
  document.getElementById('btn-add-col').disabled = false;
  // COOKIE: WS-handshake — браузер сам отправит cookie, query param не нужен
  connectWS();
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

// ── WebSocket -----------------------------------------------------------------
function connectWS() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer=null; }
  if (ws) { ws.onclose=null; if(ws.readyState!==WebSocket.CLOSED) ws.close(); }
  // COOKIE: браузер автоматически отправляет cookie при WS-handshake (same origin)
  ws = new WebSocket(`${WS_BASE}/ws`);
  ws.onerror = () => logEvent('error','WS error — will retry');
  ws.onmessage = async (e) => {
    let msg; try { msg=JSON.parse(e.data); } catch { return; }
    if (msg.event==='card_dragging') { _handleRemoteDrag(msg.payload); return; }
    logEvent(msg.event, JSON.stringify(msg.payload));
    if (isUiLocked) return;
    switch(msg.event) {
      case 'column_created': 
      case 'column_updated': 
      case 'column_deleted': 
        await loadBoard(); 
        break;
      case 'card_created': 
      case 'card_updated': 
      case 'card_moved': 
      case 'card_deleted': 
        await loadOnlineUsers(); 
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

function _handleRemoteDrag({card_id,dragged_by,username}) {
  if (currentUser && dragged_by===currentUser.user_id) return;
  const el = document.querySelector(`[data-card-id="${card_id}"]`);
  if (el) { el.classList.add('remote-drag'); el.title=`Moving: ${username}`; }
  const prev = remoteDrags.get(card_id);
  if (prev) clearTimeout(prev);
  remoteDrags.set(card_id, setTimeout(()=>{
    const e=document.querySelector(`[data-card-id="${card_id}"]`);
    if(e){e.classList.remove('remote-drag');e.title='';}
    remoteDrags.delete(card_id);
  },2000));
}
function _sendDragEvent(cardId,srcColId,curColId,curPos) {
  if (!ws||ws.readyState!==WebSocket.OPEN||!currentUser) return;
  ws.send(JSON.stringify({event:'card_dragging',card_id:cardId,
    source_column_id:srcColId,current_column_id:curColId,current_position:curPos}));
}

// ── Data ----------------------------------------------------------------------
async function loadBoard() {
  try {
    const [cols, crds, usrs] = await Promise.all([
      api('GET', '/columns'),
      api('GET', '/cards'),
      api('GET', '/users')
    ]);
    
    columns = cols;
    cards = crds;
    allUsers = usrs;
    
    if (typeof updateAssigneeSelect === 'function') updateAssigneeSelect();
    renderBoard();
  } catch (e) {
    console.error("Board load failed", e);
  }
}

async function loadCards() { cards = await api('GET','/cards'); }
async function loadOnlineUsers() {
  const users = await api('GET','/users/online');
  document.getElementById('online-users').innerHTML = users.length
    ? users.map(u=>`<span class="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-xs">${esc(u.username)}</span>`).join('')
    : '<span class="text-gray-400 text-xs">nobody</span>';
}

async function loadAllUsers() {
    try {
        const users = await api('GET', '/users');
        allUsers = users;
        const select = document.getElementById('card-assign-select');
        if (!select) return;

        // ТОЧЕЧНОЕ ИСПРАВЛЕНИЕ: фильтруем currentUser
        const otherUsers = users.filter(u => u.user_id !== currentUser?.user_id);

        select.innerHTML = '<option value="">-- Unassigned --</option>' + 
            otherUsers.map(u => `<option value="${u.user_id}">${esc(u.username)}</option>`).join('');
    } catch (e) {
        console.error('Failed to load users for select', e);
    }
}

// ── Render --------------------------------------------------------------------
function renderBoard() {
  if (boardSortable) { boardSortable.destroy(); boardSortable=null; }
  cardSortables.forEach(s=>s.destroy()); cardSortables.clear();
  const board = document.getElementById('board');
  board.innerHTML = '';
  [...columns].sort((a,b)=>a.position-b.position).forEach(col => {
    const colCards = cards.filter(c=>c.column_id===col.id).sort((a,b)=>a.position-b.position);
    board.insertAdjacentHTML('beforeend', _renderColumn(col,colCards));
  });
  _initBoardSortable();
  columns.forEach(col=>_initCardSortable(col.id));
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
          ${ce?`<button onclick="deleteColumn('${col.id}')" class="text-xs text-red-400 hover:text-red-600" title="Delete">✕</button>`:''}
        </div>
      </div>
      <div class="card-list px-3 py-2 flex flex-col gap-2 flex-1 min-h-[40px]" data-col-id="${col.id}">
        ${colCards.map(c=>_renderCard(c)).join('')}
      </div>
      ${ce?`<div class="px-3 pb-3">
        <button onclick="openAddCard('${col.id}')"
          class="w-full text-xs text-indigo-600 border border-indigo-200 rounded px-2 py-1.5 hover:bg-indigo-50">+ Card</button>
      </div>`:''}
    </div>`;
}

function _renderCard(c) {
  const creator = allUsers.find(u => u.user_id === c.created_by)?.username || 'Unknown';
    const assignee = c.assigned_to 
        ? (allUsers.find(u => u.user_id === c.assigned_to)?.username || 'Unknown') 
        : 'Unassigned';
        
    const displayDate = new Date(c.updated_at || c.created_at).toLocaleString([], {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    return `
      <div class="card bg-white border rounded-lg p-3 text-sm flex flex-col gap-2 
        cursor-pointer hover:shadow-md hover:-translate-y-0.5 
        transition-all duration-200 group" 
        data-card-id="${c.id}" 
        onclick="openEditCard('${c.id}')">
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
            <button onclick="event.stopPropagation(); openEditCard('${c.id}')" class="text-blue-500 hover:text-blue-700">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
            </button>
            <button onclick="event.stopPropagation(); deleteCard('${c.id}')" class="text-red-400 hover:text-red-600">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </div>
      </div>`;
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── SortableJS: COLUMNS -------------------------------------------------------
function _initBoardSortable() {
  boardSortable = Sortable.create(document.getElementById('board'), {
    animation: 200,
    handle: '.col-handle',   // только за шапку
    ghostClass: 'col-ghost',
    dragClass: 'col-drag',
    chosenClass: 'col-chosen',
    disabled: !currentUser,
    async onEnd(evt) {
      // if (!currentUser) return;
      // const colId = evt.item.dataset.columnId;
      // const newPos = evt.newIndex ?? 0;
      // const col = columns.find(c=>c.id===colId);
      // if (col) col.position = newPos;  // оптимистично

      if (!currentUser || evt.oldIndex === evt.newIndex) return;

      isUiLocked = true;

      const colId = evt.item.dataset.columnId;
      const newPos = evt.newIndex;

      // 1. Сначала обновляем локальный массив columns, чтобы рендер был верным
      const movedCol = columns.find(c => c.id === colId);
      if (movedCol) {
        // Удаляем из старого места и вставляем в новое
        columns.splice(evt.oldIndex, 1);
        columns.splice(evt.newIndex, 0, movedCol);
        
        // Пересчитываем position для всех колонок
        columns.forEach((c, i) => c.position = i);
      }
      try { await api('PUT', `/columns/${colId}`, {position: newPos});} 
      catch(err) {logEvent('error','Column move failed: '+err.message); await loadBoard();} 
      finally{setTimeout(() => { isUiLocked = false; }, 500);}
    },
  });
}

// ── SortableJS: CARDS ---------------------------------------------------------
function _initCardSortable(columnId) {
  const listEl = document.querySelector(`.card-list[data-col-id="${columnId}"]`);
  if (!listEl) return;
  let srcColId=null, cardId=null, throttle=null;
  const s = Sortable.create(listEl, {
    group: 'cards',
    animation: 150,
    ghostClass: 'card-ghost',
    dragClass: 'card-drag',
    chosenClass: 'card-chosen',
    disabled: !currentUser,
    onStart(e) { cardId=e.item.dataset.cardId; srcColId=e.item.dataset.colId; },
    onMove(e) {
      if (!cardId||!currentUser) return;
      if (throttle) return;
      throttle = setTimeout(()=>{throttle=null;},80);
      _sendDragEvent(cardId, srcColId, e.to.dataset.colId,
        Math.max(0, Array.from(e.to.children).indexOf(e.related)));
    },
    async onEnd(e) {
      if (throttle){clearTimeout(throttle);throttle=null;}
      if (!cardId||!currentUser) return;
      const mid=cardId, tCol=e.to.dataset.colId, tPos=e.newIndex??0;
      cardId=srcColId=null;
      const card=cards.find(c=>c.id===mid);
      isUiLocked = true;

      if(card){card.column_id=tCol;card.position=tPos;}
      try { await api('POST',`/cards/${mid}/move`,{target_column_id:tCol,target_position:tPos}); }
      catch(err){logEvent('error','Card move failed: '+err.message);await loadBoard();}
      finally {setTimeout(() => { isUiLocked = false; }, 500);}
    },
  });
  cardSortables.set(columnId, s);
}

// ── Column actions ------------------------------------------------------------
function openAddColumn(){
  document.getElementById('new-col-name').value='';
  document.getElementById('modal-add-column').showModal();
  setTimeout(()=>document.getElementById('new-col-name').focus(),50);
}
async function submitAddColumn(){
  const name=document.getElementById('new-col-name').value.trim();
  if(!name) return alert('Column name is required');
  try{ await api('POST','/columns',{name}); document.getElementById('modal-add-column').close(); await loadBoard(); }
  catch(e){alert(e.message);}
}
async function deleteColumn(id){
  if(!confirm('Delete this column? (Must be empty)')) return;
  try{ await api('DELETE',`/columns/${id}`); await loadBoard(); }
  catch(e){alert(e.message);}
}

// ── Card actions --------------------------------------------------------------
function openAddCard(colId){
  document.getElementById('modal-card-title').textContent='New Card';
  document.getElementById('card-edit-id').value='';
  document.getElementById('card-col-id').value=colId;
  document.getElementById('card-title-input').value='';
  document.getElementById('card-desc-input').value='';
  document.getElementById('modal-card').showModal();
  setTimeout(()=>document.getElementById('card-title-input').focus(),50);
}
function openEditCard(cardId){
  const card=cards.find(c=>c.id===cardId); if(!card) return;
  document.getElementById('modal-card-title').textContent='Edit Card';
  document.getElementById('card-edit-id').value=cardId;
  document.getElementById('card-col-id').value=card.column_id;
  document.getElementById('card-title-input').value=card.title;
  document.getElementById('card-desc-input').value=card.description||'';

  const select = document.getElementById('card-assign-select');
  if (select) {
    select.value = card.assigned_to || "";
  }

  document.getElementById('modal-card').showModal();
  setTimeout(()=>document.getElementById('card-title-input').focus(),50);
}
async function submitCard(){
  const editId=document.getElementById('card-edit-id').value;
  const colId=document.getElementById('card-col-id').value;
  const title=document.getElementById('card-title-input').value.trim();
  const desc=document.getElementById('card-desc-input').value.trim();
  const assigneeVal = document.getElementById('card-assign-select').value;
  const assigned_to = assigneeVal ? assigneeVal : null;

  if(!title) return alert('Title is required');
  try{
    const payload = { 
      title: title, 
      description: desc || null,
      assigned_to: assigned_to || null
    };

    if(editId) {
      await api('PUT',`/cards/${editId}`, payload)
    } else {
      payload.column_id = colId;
      payload.created_by = currentUser.user_id;
      await api('POST','/cards', payload)
    };
    document.getElementById('modal-card').close();
    await loadBoard();
  } catch(e){alert(e.message);}
}
async function deleteCard(id){
  if(!confirm('Delete this card?')) return;
  try{ await api('DELETE',`/cards/${id}`); await loadCards(); renderBoard(); }
  catch(e){alert(e.message);}
}

// ── Init ----------------------------------------------------------------------
(async()=>{
  try {
    const me = await api('GET','/users/me');
    if (me && me.user_id) {
        currentUser = { user_id: me.user_id, username: me.username };
        _uiLoggedIn();
        await Promise.all([
            loadBoard(),
            loadOnlineUsers(),
            loadAllUsers()
        ]);
        connectWS();
    } else {
      _uiLoggedOut();
    }
  } catch(e) { _uiLoggedOut(); }
})();

// CUSTO JS || close dialog window
document.addEventListener('click', (e) => {
    if (e.target.tagName === 'DIALOG') {
        const rect = e.target.getBoundingClientRect();
        const isInDialog = (
            rect.top <= e.clientY &&
            e.clientY <= rect.top + rect.height &&
            rect.left <= e.clientX &&
            e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
            e.target.close();
        }
    }
});