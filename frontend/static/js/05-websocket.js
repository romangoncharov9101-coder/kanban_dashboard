'use strict';
// WebSocket, очередь обновлений, подсветка чужого перетаскивания.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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

  // Версия, с которой реально загружена текущая страница (проставлена
  // сервером в <meta name="app-version"> при отдаче index.html). Шлём её
  // серверу при каждом коннекте/реконнекте — если после деплоя она
  // разойдётся с тем, что лежит на диске сейчас, сервер пришлёт 'app_updated'.
  const appVersion = document.getElementById('app-version-meta')?.content || '';
  ws = new WebSocket(`${WS_BASE}/ws${appVersion ? `?v=${encodeURIComponent(appVersion)}` : ''}`);
 
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

    if (msg.event === 'app_updated') { showAppUpdateBanner(); return; }
    if (msg.event === 'card_dragging') { _handleRemoteDrag(msg.payload); return; }
    if (msg.event === 'card_unassigned') {
      // Нас сняли с задачи — она больше не видна, убираем с доски.
      const gone = msg.payload?.id;
      cards = cards.filter(c => String(c.id) !== String(gone));
      const openId = document.getElementById('card-edit-id')?.value;
      if (openId && String(openId) === String(gone)) {
        document.getElementById('modal-card').close();
        toast.info('Вас сняли с этой задачи');
      }
      renderBoard();
      return;
    }
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
      case 'project_created':   case 'project_updated':   case 'project_deleted':
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
 
  // Изменения в дереве проектов затрагивают меню и сводку — только полная сборка
  const needsFull    = events.has('user_created')
                    || events.has('project_created')
                    || events.has('project_updated')
                    || events.has('project_deleted');
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
 