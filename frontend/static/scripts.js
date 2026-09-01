'use strict';

const API = window.location.origin + '/api';

const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let currentUser = null;
let ws = null, wsTimer = null;
let columns = [], cards = [], onlineUsers = [];
let boardSortable = null;
let searchTimeout = null;
let selectedAssignees = [];   // [{user_id, username}] в открытой модалке карточки
let projects = [];            // дерево проектов, доступное текущему пользователю
let currentProject = null;    // {id, name, parent_id, is_root, can_manage}
let subSections = [];         // сводка подпроектов на корневом проекте
let selectedOwners = [];      // постановщики в модалке проекта
let selectedMembers = [];     // ответственные исполнители в модалке проекта
let _assigneesLocked = false; // состав исполнителей нельзя менять (личная задача)
const GLOBAL_BOARD_ID = '__all__';  // псевдо-проект «Все проекты» (только админ)
const JOURNAL_ID = '__journal__';   // вкладка «Журнал действий» (только админ)

let journalOffset = 0;
let journalTotal = 0;
const JOURNAL_LIMIT = 50;
let journalSearchTimer = null;

let globalUserFilter = '';   // user_id: показывать только его задачи (вкладка «Все проекты»)

// Стадия работы над задачей. Отличается от категории: колонки свои
// в каждом проекте, а статус общий для всей системы.
const STATUS_META = {
  NOT_STARTED: { label: 'Не начата', short: 'Не начата', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  IN_PROGRESS: { label: 'В работе',  short: 'В работе',  cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  REVIEW:      { label: 'Проверка',  short: 'Проверка',  cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  REWORK:      { label: 'Доработка', short: 'Доработка', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  DONE:        { label: 'Готово',    short: 'Готово',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

function _statusMeta(value) {
  return STATUS_META[value] || STATUS_META.NOT_STARTED;
}

// Статус двигает тот, кто над задачей работает: админ, автор задачи
// и любой её исполнитель. Это шире, чем право править саму задачу.
function canChangeStatus(card) {
  if (!currentUser || !card) return false;
  if (isAdmin()) return true;
  const meId = String(currentUser.user_id);
  if ((card.assignees || []).some(a => String(a.user_id) === meId)) return true;
  return currentUser.role === 'TEAM_LEAD' && String(card.created_by) === meId;
}

function isJournalView() {
  return !!currentProject && String(currentProject.id) === JOURNAL_ID;
}

function isGlobalBoard() {
  return !!currentProject && String(currentProject.id) === GLOBAL_BOARD_ID;
}
let cardModalReadOnly = false;  // полный запрет редактирования (архив, чужой проект)
let cardModalCommentOnly = false; // только комментарии: назначен исполнителем, но не автор
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

  // Панель логов на доске убрана: история действий живёт на вкладке
  // «Журнал действий» и в файловом архиве на сервере. Здесь оставляем
  // только вывод в консоль браузера для отладки WebSocket.
  const el = document.getElementById('event-log');
  if (el) {
    el.insertAdjacentHTML('afterbegin',
      `<div class="${colors[type] || 'text-slate-600'}">[${new Date().toLocaleTimeString()}] <b>${type}</b> ${esc(String(msg).substring(0, 120))}</div>`);
    while (el.children.length > 100) el.lastChild.remove();
  }
}
function clearLog() {
  const el = document.getElementById('event-log');
  if (el) el.innerHTML = '';
}

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
// Раньше здесь был белый список из букв, цифр и пробелов — он резал
// скобки, кавычки, тире и запятые в названиях. Теперь наоборот:
// запрещены только управляющие и невидимые символы, всё печатное можно.
const _CTRL_CHARS = /[\p{Cc}\p{Cf}]/u;

// Возвращает текст ошибки или null, если название допустимо
function validateName(value, maxLen, what) {
  const v = String(value || '').trim();
  if (!v) return `${what} не может быть пустым`;
  if (v.length > maxLen) return `${what}: не более ${maxLen} символов`;
  if (_CTRL_CHARS.test(v)) return `${what} содержит недопустимые символы`;
  return null;
}
 
// Самостоятельной регистрации нет: аккаунты заводит администратор.
// Роли: ADMIN — управляет пользователями; TEAM_LEAD — ведёт доску;
// USER — видит только свои задачи и двигает их по разрешённым категориям.
const ROLE_LABELS = {
  ADMIN:     { text: 'Админ',     cls: 'bg-rose-100 text-rose-700' },
  TEAM_LEAD: { text: 'Постановщик', cls: 'bg-violet-100 text-violet-700' },
  USER:      { text: 'Исполнитель', cls: 'bg-slate-100 text-slate-600' },
};

function isAdmin()   { return currentUser?.role === 'ADMIN'; }
function isManager() { return currentUser?.role === 'ADMIN' || currentUser?.role === 'TEAM_LEAD'; }

// Право менять саму задачу принадлежит админу и АВТОРУ задачи.
// Постановщик, которого лишь назначили исполнителем чужой задачи,
// её не редактирует — только комментирует и двигает.
function canManageCard(card) {
  if (!currentUser || !card) return false;
  if (isAdmin()) return true;
  return currentUser.role === 'TEAM_LEAD'
      && String(card.created_by) === String(currentUser.user_id);
}

// Карточка принадлежит другому проекту (пришла в сводку подпроектов).
// Такую нельзя перетаскивать между досками, но открывать, комментировать
// и — если ты автор или админ — редактировать можно точно так же,
// как на доске самого подпроекта.
function isForeignBoardCard(card) {
  if (!card || !currentProject) return false;
  // В общем виде своей доски нет вообще — там все карточки «чужие»
  // в смысле перетаскивания, и это нормально.
  if (isGlobalBoard()) return true;
  return String(card.project_id) !== String(currentProject.id);
}

// Ограничение по разрешённым категориям снимается для автора задачи,
// админа и ответственного за проект. Тот, кто просто назначен
// исполнителем, кладёт задачу только в открытые категории.
// Может ли текущий пользователь завести задачу в этой категории.
// Админ и ответственный за проект — везде. Исполнитель — только там,
// где админ разрешил личные задачи.
function canCreateInColumn(col) {
  if (!currentUser || !col) return false;
  if (isAdmin()) return true;
  if (isManager() && currentProject?.can_manage) return true;
  // Заводить задачи может только ответственный именно этого проекта
  // или подпроекта. Ответственный за родителя здесь посторонний,
  // даже если категория открыта для создания.
  return !!(col.is_user_creatable && currentProject?.is_member);
}

function canMoveInto(columnId, card) {
  if (!currentUser) return false;
  if (canManageCard(card)) return true;
  if (currentProject?.can_manage) return true;
  const col = columns.find(c => String(c.id) === String(columnId));
  return !!(col && col.is_user_movable);
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
  currentUser = { user_id: user.user_id, username: user.username, role: user.role || 'USER' };

  const roleInfo = ROLE_LABELS[currentUser.role] || ROLE_LABELS.USER;
  ['current-role', 'current-role-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = roleInfo.text; el.className = `text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleInfo.cls}`; }
  });
  ['btn-admin-panel', 'btn-admin-panel-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdmin() ? '' : 'none';
  });

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

  const addColBtn = document.getElementById('btn-add-col');
  addColBtn.disabled = !isManager();
  addColBtn.style.display = isManager() ? '' : 'none';
  const projBtn = document.getElementById('btn-projects');
  if (projBtn) projBtn.style.display = '';
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
  projects = []; currentProject = null; subSections = []; _allUsers = [];
  journalOffset = 0; journalTotal = 0;
  const journalView = document.getElementById('journal-view');
  if (journalView) journalView.style.display = 'none';
  const boardBack = document.getElementById('board');
  if (boardBack) boardBack.style.display = '';
  sessionStorage.removeItem('last_project_id');
  sessionStorage.removeItem('last_board_state');
  const secHost = document.getElementById('subproject-sections');
  if (secHost) secHost.innerHTML = '';
  const projBtn = document.getElementById('btn-projects');
  if (projBtn) projBtn.style.display = 'none';
  globalUserFilter = '';
  const fbar = document.getElementById('global-filter-bar');
  if (fbar) fbar.style.display = 'none';
  closeProjectDrawer();
  ['btn-admin-panel', 'btn-admin-panel-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  ['current-role', 'current-role-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });

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
 
// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────────────────────
async function loadBoard() {
  // Журнал живёт отдельно от доски и грузится своим запросом
  if (isJournalView()) {
    if (isAdmin()) {
      _applyJournalLayout();
      _renderProjectTree();
      await _fillJournalUsers();
      await loadJournal();
      return;
    }
    // роль понизили — журнал больше не наш
    currentProject = null;
    _applyJournalLayout();
  }

  let data;
  if (isGlobalBoard()) {
    data = await api('GET', '/board/all');
    // Роль могли понизить, пока вкладка открыта — общий вид больше не наш
    if (!data) { currentProject = null; data = await api('GET', '/board/init'); }
  } else {
    const qs = currentProject ? `?project_id=${encodeURIComponent(currentProject.id)}` : '';
    data = await api('GET', `/board/init${qs}`);
  }
  if (!data) return;

  projects = data.projects || [];
  subSections = data.sections || [];
  currentProject = data.project || null;
  _renderProjectTree();
  _renderProjectHeader();
  if (currentProject) sessionStorage.setItem('last_project_id', String(currentProject.id));

  // Роль может измениться, пока вкладка открыта (админ поменял),
  // поэтому берём её из ответа сервера, а не только из логина.
  if (data.me && currentUser) {
    if (currentUser.role !== data.me.role) {
      currentUser.role = data.me.role;
      _applyRoleToUI();
    }
  }

  columns = data.columns || [];
  cards = data.cards || [];
  onlineUsers = data.online_users || [];

  // Помечаем кеш владельцем: иначе при смене учётки в той же вкладке
  // новый пользователь увидит доску предыдущего до окончания загрузки.
  sessionStorage.setItem('last_board_state', JSON.stringify({
    ...data,
    _owner: currentUser?.user_id || null,
  }));

  renderBoard();
}
 
async function _loadCards() {
  if (!currentUser) return;
  // На корневом проекте есть ещё и сводка подпроектов —
  // её умеет пересобрать только /board/init.
  // Корневой проект показывает ещё и сводку подпроектов — её собирает
  // только /board/init. Точечная догрузка /cards тут не годится.
  // Общий вид и корневой проект содержат сводку по другим проектам —
  // её собирает только полный запрос доски.
  if (isGlobalBoard() || (currentProject && currentProject.is_root)) return loadBoard();

  const pq = currentProject ? `?project_id=${encodeURIComponent(currentProject.id)}` : '';
  const crds = await api('GET', `/cards${pq}`);
  if (!crds) return;
  cards = crds;
  renderBoard();
}
 
async function _loadColumns() {
  if (!currentUser) return;
  // Корневой проект показывает ещё и сводку подпроектов — её собирает
  // только /board/init. Точечная догрузка /cards тут не годится.
  // Общий вид и корневой проект содержат сводку по другим проектам —
  // её собирает только полный запрос доски.
  if (isGlobalBoard() || (currentProject && currentProject.is_root)) return loadBoard();

  const pq = currentProject ? `?project_id=${encodeURIComponent(currentProject.id)}` : '';
  const [cols, crds] = await Promise.all([
    api('GET', `/columns${pq}`),
    api('GET', `/cards${pq}`),
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
    const allowed = currentUser && isManager() && !isArchived && !!currentProject?.can_manage;
    btnAddCol.style.display = allowed ? '' : 'none';
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
  _renderSubprojectSections();
  _renderGlobalFilterBar();
}
 
function _renderColumn(col, colCards) {
  const ce = !!currentUser;
  // Категориями и задачами проекта распоряжается тот, кто за него отвечает
  const canManage = ce && isManager() && !!currentProject?.can_manage;
  const isArchived = currentFilterMode === 'archived';
  const count = colCards.length;
  // Для исполнителя показываем, куда ему разрешено перетаскивать.
  const showDropHint = ce && !canManage && !isArchived;
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
        ${canManage && !isArchived ? `<div class="flex items-center gap-1 flex-shrink-0 ml-2">
          <button onclick="event.stopPropagation(); toggleColumnUserAccess('${col.id}')"
            data-lock-btn
            class="text-sm ${col.is_user_movable ? 'text-emerald-500 hover:text-emerald-600' : 'text-slate-300 hover:text-slate-500'}"
            title="${col.is_user_movable ? 'Исполнители могут переносить сюда задачи. Нажмите, чтобы запретить' : 'Исполнителям запрещено переносить сюда задачи. Нажмите, чтобы разрешить'}">
            ${col.is_user_movable ? '↕' : '—'}
          </button>
          ${isAdmin() ? `<button onclick="event.stopPropagation(); toggleColumnUserCreate('${col.id}')"
            data-create-btn
            class="text-sm ${col.is_user_creatable ? 'text-indigo-500 hover:text-indigo-600' : 'text-slate-400 hover:text-slate-600'}"
            title="${col.is_user_creatable ? 'Исполнители могут заводить здесь личные задачи. Нажмите, чтобы запретить' : 'Разрешить исполнителям заводить здесь личные задачи'}">
            ${col.is_user_creatable ? '🔵' : '⚪'}
          </button>` : ''}
          <button onclick="deleteColumn('${col.id}')"
            class="text-slate-400 hover:text-red-500 text-sm" title="Удалить">✕</button>
        </div>` : ''}
      </div>
      <!-- Add card (скрыто в режиме архива и для исполнителей) -->
      ${(canManage || canCreateInColumn(col)) && !isArchived ? `<div class="px-2 pb-2">
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

    // При активном фильтре — скрываем пустые колонки (кроме 'all')
    const hiddenByFilter = currentFilterMode !== 'all' && !hasCards;

    // Кому колонка нужна:
    //   админ и ответственный за проект — все колонки, включая пустые;
    //   остальные — колонки со своими задачами ПЛЮС открытые для переноса,
    //   иначе перетаскивать будет некуда: пустая колонка-приёмник
    //   пропадала бы с доски и дропнуть карточку было невозможно.
    const canManageThisProject = !!(currentProject && currentProject.can_manage);
    // Ответственный исполнитель работает со всем проектом целиком —
    // прятать от него категории нельзя, иначе он не найдёт, куда
    // положить задачу.
    const isProjectMember = !!(currentProject && currentProject.is_member);
    const col = columns.find(c => String(c.id) === String(colId));

    // Пустая категория нужна, если в неё можно перетащить задачу
    // ИЛИ завести там новую: иначе открытая для создания колонка
    // исчезала с доски и кнопка «+ Задача» была недоступна.
    const isDropTarget = !!(col && col.is_user_movable);
    const isCreateTarget = !!(col && col.is_user_creatable);

    const hiddenByRole = !isAdmin()
      && !canManageThisProject
      && !isProjectMember
      && !hasCards
      && !isDropTarget
      && !isCreateTarget
      && currentFilterMode !== 'archived';

    if (hiddenByFilter || hiddenByRole) {
      colEl.classList.add('hidden');
    } else {
      colEl.classList.remove('hidden');
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
  const assignees = c.assignees || [];
  // Карточка из сводки подпроекта: перетаскивать нельзя (другая доска),
  // но кнопки редактирования подчиняются обычному праву по авторству.
  const foreign = isForeignBoardCard(c);
  const canManage = canManageCard(c);
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
  const st = _statusMeta(c.status);
 
  return `
    <div class="card bg-white border border-slate-200 rounded-xl text-sm flex flex-col
                overflow-hidden hover:shadow-md hover:-translate-y-px transition-all duration-150 group relative"
         data-card-id="${c.id}" data-col-id="${c.column_id}"
         ${foreign ? 'data-foreign="1"' : ''}
         onclick="openEditCard('${c.id}')">

      <div class="absolute left-0 top-0 bottom-0 w-1 ${p.color}"></div>

      ${_previewImage(c.attachments)}

      <div class="pl-4 pr-3 pt-2.5 pb-2 flex flex-col gap-1.5"> 
        <div class="flex items-start justify-between gap-1">
          <div class="flex flex-col gap-1 flex-1">
            <div class="flex flex-wrap items-center gap-1">
              <span class="inline-block w-fit px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${p.bg} ${p.textColor}">
                ${p.text}
              </span>
              <span class="inline-block w-fit px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${st.cls}">
                ${st.short}
              </span>
            </div>
            <span class="font-semibold text-slate-800 text-[13px] leading-tight line-clamp-2"
                  title="${esc(c.title)}">${esc(c.title)}</span>
          </div>

          ${canManage ? `
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
            ${assignees.length ? `<span class="text-[10px] text-indigo-500 font-medium truncate"
                title="${esc(assignees.map(a => a.username).join(', '))}">
                👤 ${esc(assignees[0].username)}${assignees.length > 1 ? ` +${assignees.length - 1}` : ''}
              </span>` : '<span class="text-[10px] text-slate-300 italic">без исполнителя</span>'}
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
  const card = findCardById(cardId);
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
  if (!canManageCard(findCardById(cardId)))
    return toast.warn('Архивировать может только автор задачи или администратор');
  if (!confirm('Переместить карточку в архив?')) return;

  const res = await api('POST', `/cards/${cardId}/archive`);
  if (res) {
    toast.success('Карточка перемещена в архив');
    
    const card = findCardById(cardId);
    if (card) card.is_archived = true;
    renderBoard(); 
  }
}

async function unarchiveCardAction(e, cardId) {
  if (e) e.stopPropagation();
  if (!canManageCard(findCardById(cardId)))
    return toast.warn('Восстанавливать может только автор задачи или администратор');

  const res = await api('POST', `/cards/${cardId}/unarchive`);
  if (res) {
    toast.success('Карточка восстановлена из архива');
    
    const card = findCardById(cardId);
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

// ─────────────────────────────────────────────────────────────────────────────
// DEADLINE PICKER — календарь с быстрым выбором вместо datetime-local.
// Системный datetime-local нельзя стилизовать и в нём нет пресетов.
// ─────────────────────────────────────────────────────────────────────────────
let _dlValue = null;   // выбранная дата (Date) или null
let _dlMonth = null;   // месяц, показанный в календаре

const _MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                 'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

// Быстрый выбор: смещение от «сейчас» в днях и время по умолчанию
const DEADLINE_SHORTCUTS = [
  { text: 'Сегодня',      days: 0,  hour: 18 },
  { text: 'Завтра',       days: 1,  hour: 12 },
  { text: 'Через 3 дня',  days: 3,  hour: 12 },
  { text: 'Через неделю', days: 7,  hour: 12 },
  { text: 'Через месяц',  days: 30, hour: 12 },
];

function _dlShortcutDate(sc) {
  const d = new Date();
  d.setDate(d.getDate() + sc.days);
  d.setHours(sc.hour, 0, 0, 0);
  return d;
}

function _dlFormat(d) {
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function _dlSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function toggleDeadlinePicker(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('deadline-panel');
  if (!panel) return;
  panel.style.display !== 'none' ? closeDeadlinePicker() : openDeadlinePicker();
}

function openDeadlinePicker() {
  const trigger = document.getElementById('deadline-trigger');
  if (trigger && trigger.disabled) return;      // режим просмотра

  const panel = document.getElementById('deadline-panel');
  if (!panel) return;

  _dlMonth = new Date(_dlValue || new Date());
  _dlMonth.setDate(1);
  panel.style.display = '';
  _renderDeadlineShortcuts();
  _renderDeadlineCalendar();

  const time = document.getElementById('deadline-time');
  if (time) {
    const d = _dlValue || new Date();
    time.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

function closeDeadlinePicker() {
  const panel = document.getElementById('deadline-panel');
  if (panel) panel.style.display = 'none';
}

function _renderDeadlineShortcuts() {
  const box = document.getElementById('deadline-shortcuts');
  if (!box) return;
  box.innerHTML = DEADLINE_SHORTCUTS.map((sc, i) => `
    <button type="button" onclick="pickDeadlineShortcut(${i})"
      class="text-left text-xs text-slate-600 px-3 py-1.5 hover:bg-indigo-50
             hover:text-indigo-700 transition-colors">${esc(sc.text)}</button>`).join('');
}

function pickDeadlineShortcut(index) {
  const sc = DEADLINE_SHORTCUTS[index];
  if (!sc) return;
  _dlValue = _dlShortcutDate(sc);
  _dlMonth = new Date(_dlValue);
  _dlMonth.setDate(1);
  _applyDeadlineValue();
  closeDeadlinePicker();
}

function _renderDeadlineCalendar() {
  const box = document.getElementById('deadline-days');
  const title = document.getElementById('deadline-month');
  if (!box || !_dlMonth) return;

  title.textContent = `${_MONTHS[_dlMonth.getMonth()]} ${_dlMonth.getFullYear()}`;

  const first = new Date(_dlMonth);
  // В России неделя начинается с понедельника, а getDay() — с воскресенья
  const shift = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth() + 1, 0).getDate();
  const today = new Date();

  const cells = [];
  for (let i = 0; i < shift; i++) cells.push('<span></span>');

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth(), day);
    const isToday = _dlSameDay(d, today);
    const isSelected = _dlSameDay(d, _dlValue);
    const isPast = d < new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const cls = isSelected
      ? 'bg-indigo-600 text-white font-semibold'
      : isToday
        ? 'text-indigo-600 font-semibold hover:bg-indigo-50'
        : isPast
          ? 'text-slate-300 hover:bg-slate-100'   // прошлое доступно, но приглушено
          : 'text-slate-700 hover:bg-indigo-50';

    cells.push(`<button type="button" onclick="pickDeadlineDay(${day})"
      class="h-7 rounded text-xs transition-colors ${cls}">${day}</button>`);
  }
  box.innerHTML = cells.join('');
}

function deadlineShiftMonth(delta) {
  if (!_dlMonth) return;
  _dlMonth = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth() + delta, 1);
  _renderDeadlineCalendar();
}

function pickDeadlineDay(day) {
  const time = document.getElementById('deadline-time');
  const [h, m] = (time?.value || '12:00').split(':').map(Number);
  _dlValue = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth(), day, h || 0, m || 0, 0, 0);
  _renderDeadlineCalendar();
  _applyDeadlineValue();
}

function deadlineSetNow() {
  _dlValue = new Date();
  _dlMonth = new Date(_dlValue);
  _dlMonth.setDate(1);
  const time = document.getElementById('deadline-time');
  if (time) {
    time.value = `${String(_dlValue.getHours()).padStart(2, '0')}:${String(_dlValue.getMinutes()).padStart(2, '0')}`;
  }
  _renderDeadlineCalendar();
  _applyDeadlineValue();
}

function confirmDeadline() {
  const time = document.getElementById('deadline-time');
  if (time && time.value) {
    const [h, m] = time.value.split(':').map(Number);
    const base = _dlValue || new Date();
    _dlValue = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h || 0, m || 0, 0, 0);
  }
  _applyDeadlineValue();
  closeDeadlinePicker();
}

// Записывает выбранное значение в скрытое поле и обновляет подпись
function _applyDeadlineValue() {
  const input = document.getElementById('card-deadline-input');
  const label = document.getElementById('deadline-label');
  const clearBtn = document.getElementById('card-deadline-clear');

  if (input) input.value = _dlValue ? _dlValue.toISOString() : '';
  if (label) {
    label.textContent = _dlValue ? _dlFormat(_dlValue) : 'Выберите дату и время';
    label.classList.toggle('text-slate-800', !!_dlValue);
    label.classList.toggle('text-slate-500', !_dlValue);
  }
  if (clearBtn) clearBtn.classList.toggle('hidden', !_dlValue);
  _validateDeadline();
}

// Подставляет значение при открытии карточки
function setDeadlineValue(iso) {
  _dlValue = iso ? new Date(iso) : null;
  if (_dlValue && isNaN(_dlValue)) _dlValue = null;
  _applyDeadlineValue();
}

function clearDeadline() {
  _dlValue = null;
  _applyDeadlineValue();
  closeDeadlinePicker();
}

function _updateDeadlineClearBtn() {
  const clearBtn = document.getElementById('card-deadline-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !_dlValue);
}

// Просрочка больше не блокирует сохранение: это подсказка, а не ошибка.
// Иначе просроченную задачу нельзя было бы отредактировать — клиент
// отправлял обратно истёкший дедлайн и сам себя отклонял.
function _validateDeadline() {
  const errEl = document.getElementById('deadline-error');
  if (!_dlValue) {
    if (errEl) errEl.classList.add('hidden');
    return null;
  }
  if (errEl) errEl.classList.toggle('hidden', _dlValue > new Date());
  return _dlValue.toISOString();
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
 
    item.appendChild(iconSpan);
    item.appendChild(nameEl);
    item.appendChild(dlLink);

    // Удалять вложение может автор задачи или админ.
    // Скачать — любой, кто видит карточку.
    if (!cardModalReadOnly && !cardModalCommentOnly) {
      const delBtn = document.createElement('button');
      delBtn.className = 'text-red-400 hover:text-red-600 flex-shrink-0';
      delBtn.title = 'Удалить';
      delBtn.textContent = '✕';
      delBtn.onclick = () => deleteAttachment(a.id, a.isPending);
      item.appendChild(delBtn);
    }
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
  const card = findCardById(cardId);
  
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
    const card = findCardById(cardId);
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
  const card = findCardById(cardId);
  const existing = (card?.attachments || []).filter(a => !pendingDeletions.includes(a.id));
  const pending = pendingFiles.map(f => ({ filename: f.name, isPending: true }));
  
  _renderAttachmentsList([...existing, ...pending]);
  toast.success('Вложение помечено на удаление.');
}

function downloadAllAttachments() {
  const cardId = document.getElementById('card-edit-id').value;
  const card = findCardById(cardId);
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

// Кому карточка вообще положена к показу — независимо от выбранного фильтра.
// Сервер отдаёт уже отфильтрованную выдачу, но клиент может держать
// подгруженные ранее карточки (кеш доски, WS-события, переключение
// проектов), поэтому правило дублируется здесь.
// На сводном дашборде корневого проекта карточки подпроектов живут
// не в `cards`, а в subSections. Любой поиск по id должен смотреть
// в оба места, иначе действия над такой карточкой молча отваливаются:
// canManageCard(undefined) === false и пользователь видит отказ в правах.
function findCardById(cardId) {
  const id = String(cardId);
  const own = cards.find(c => String(c.id) === id);
  if (own) return own;
  for (const sec of subSections) {
    const hit = (sec.cards || []).find(c => String(c.id) === id);
    if (hit) return hit;
  }
  return null;
}

function isCardVisibleToMe(card) {
  if (!currentUser || !card) return false;
  if (isAdmin()) return true;

  const meId = String(currentUser.user_id);
  const isAssignee = (card.assignees || []).some(a => String(a.user_id) === meId);

  // Исполнитель — только то, что назначено лично ему
  if (currentUser.role !== 'TEAM_LEAD') return isAssignee;

  // Постановщик — назначенное ему плюс созданное им самим
  return isAssignee || String(card.created_by) === meId;
}

function getCardFilter() {
  const meId = currentUser?.user_id;
  return (card) => {
    if (!isCardVisibleToMe(card)) return false;

    // Выборка по конкретному исполнителю на вкладке «Все проекты»
    if (globalUserFilter && isGlobalBoard()) {
      const hit = (card.assignees || []).some(a => String(a.user_id) === String(globalUserFilter));
      if (!hit) return false;
    }

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
        return (card.assignees || []).some(a => String(a.user_id) === String(meId));
      case 'created':
        // для постановщика это подмножество и так видимого
        return card.created_by === meId;
      case 'p-high':
        return card.priority === 'HIGHT';
      case 'p-medium':
        return card.priority === 'MEDIUM';
      case 'p-low':
        return card.priority === 'LOW';

      // Стадия работы. Значение по умолчанию подставляем на случай
      // карточек, пришедших из кеша до появления статуса.
      case 's-not-started':
        return (card.status || 'NOT_STARTED') === 'NOT_STARTED';
      case 's-in-progress':
        return card.status === 'IN_PROGRESS';
      case 's-review':
        return card.status === 'REVIEW';
      case 's-rework':
        return card.status === 'REWORK';
      case 's-done':
        return card.status === 'DONE';
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
        const cardData = findCardById(cardId);
        
        if (cardData && (cardData.assignees || []).some(a => String(a.user_id) === String(currentUser.user_id))) {
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
    disabled: !currentUser || !isManager(),
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
      if (!currentUser || !isManager() || evt.oldIndex === evt.newIndex) return;
 
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
    // Исполнителю разрешено бросать карточку только в те категории,
    // которые админ/тим-лидер пометил как доступные. Проверка здесь —
    // чтобы карточка не «прыгала» и не откатывалась после отказа сервера.
    group: {
      name: 'cards',
      pull: true,
      put: function (to, from, dragged) {
        const targetColId = to.el?.dataset?.colId;
        if (!targetColId) return false;
        // Доски проектов независимы: карточку из сводки подпроекта
        // на доску родителя не переносим
        if (dragged?.dataset?.foreign === '1') return false;
        if (from === to) return true;
        const card = cards.find(c => String(c.id) === String(dragged?.dataset?.cardId));
        return canMoveInto(targetColId, card);
      },
    },
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
      const origCol = srcColId;
      cardId = srcColId = null;

      const movedCard = findCardById(mid);
      if (String(tCol) !== String(origCol) && !canMoveInto(tCol, movedCard)) {
        const colName = columns.find(c => String(c.id) === String(tCol))?.name || 'эту категорию';
        toast.warn(`Перенос в «${colName}» вам недоступен`);
        await loadBoard();
        return;
      }

      const card = movedCard;
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
  if (!isManager()) return toast.warn('Создавать категории может админ или постановщик');
  if (!currentProject) return toast.warn('Сначала выберите проект');
  if (!currentProject.can_manage) return toast.warn('Вы не отвечаете за этот проект');
  const chk = document.getElementById('new-col-user-movable');
  if (chk) chk.checked = false;
  document.getElementById('new-col-name').value = '';
  document.getElementById('modal-add-column').showModal();
  setTimeout(() => document.getElementById('new-col-name').focus(), 50);
}
 
async function submitAddColumn() {
  const name = document.getElementById('new-col-name').value.trim();
  const nameError = validateName(name, 100, 'Название категории');
  if (nameError) return toast.warn(nameError);
  const isUserMovable = !!document.getElementById('new-col-user-movable')?.checked;
  const result = await api('POST', '/columns', {
    name,
    project_id: currentProject?.id,
    is_user_movable: isUserMovable,
    // Флаг личных задач доступен только админу; для остальных ролей
    // чекбокс скрыт, и сюда всегда уйдёт false.
    is_user_creatable: isAdmin() && !!document.getElementById('new-col-user-creatable')?.checked,
  });
  if (!result) return;
  document.getElementById('modal-add-column').close();
}

// Переключает разрешение исполнителям заводить личные задачи.
// Доступно только админу: такие задачи скрыты от постановщика проекта.
async function toggleColumnUserCreate(colId) {
  if (!isAdmin()) return toast.warn('Это может настраивать только администратор');
  const col = columns.find(c => String(c.id) === String(colId));
  if (!col) return;
  const next = !col.is_user_creatable;

  const result = await api('PUT', `/columns/${colId}`, { is_user_creatable: next });
  if (!result) return;

  col.is_user_creatable = next;
  renderBoard();
  toast.success(next
    ? `Исполнители могут заводить личные задачи в «${col.name}»`
    : `Личные задачи в «${col.name}» запрещены`);
}

// Переключает разрешение для исполнителей переносить задачи в категорию.
async function toggleColumnUserAccess(colId) {
  const col = columns.find(c => String(c.id) === String(colId));
  if (!col) return;
  const next = !col.is_user_movable;

  // Оптимистичное обновление: иконка меняется мгновенно, не ожидая WS
  col.is_user_movable = next;
  _updateLockIcon(colId, next);

  const result = await api('PUT', `/columns/${colId}`, { is_user_movable: next });
  if (!result) {
    // Откатываем если сервер отклонил
    col.is_user_movable = !next;
    _updateLockIcon(colId, !next);
    return;
  }
  toast.success(next
    ? `Исполнители могут переносить задачи в «${col.name}»`
    : `Перенос в «${col.name}» теперь только для администратора и постановщика`);
}

function _updateLockIcon(colId, isMovable) {
  const colEl = document.querySelector(`[data-column-id="${colId}"]`);
  if (!colEl) return;
  const btn = colEl.querySelector('[data-lock-btn]');
  if (!btn) return;
  btn.textContent = isMovable ? '↕' : '—';
  btn.title = isMovable
    ? 'Исполнители могут переносить сюда задачи. Нажмите, чтобы запретить'
    : 'Исполнителям запрещено переносить сюда задачи. Нажмите, чтобы разрешить';
  btn.className = `text-sm ${isMovable ? 'text-emerald-500 hover:text-emerald-600' : 'text-slate-300 hover:text-slate-500'}`;
}

function _updateCreateIcon(colId, isCreatable) {
  const colEl = document.querySelector(`[data-column-id="${colId}"]`);
  if (!colEl) return;
  const btn = colEl.querySelector('[data-create-btn]');
  if (!btn) return;
  
  // Активное состояние — синий круг (🔵), неактивное — серый (⚪)
  btn.textContent = isCreatable ? '🔵' : '⚪';
  btn.title = isCreatable
    ? 'Исполнители могут заводить здесь личные задачи. Нажмите, чтобы запретить'
    : 'Разрешить исполнителям заводить здесь личные задачи';
  btn.className = `text-sm ${isCreatable ? 'text-indigo-500 hover:text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`;
}
 
async function deleteColumn(id) {
  if (!isManager()) return toast.warn('Недостаточно прав');
  if (!confirm('Удалить категорию? (Она должна быть пустой)')) return;
  await api('DELETE', `/columns/${id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNEE PICKER — свой выпадающий список вместо системного <select>:
// системный нельзя стилизовать и в нём не показать роль и аватар.
// ─────────────────────────────────────────────────────────────────────────────
let _allUsers = [];  // кеш активных пользователей на время сессии

const ROLE_CHIP = {
  ADMIN:     'bg-rose-50 text-rose-600',
  TEAM_LEAD: 'bg-violet-50 text-violet-600',
  USER:      'bg-slate-100 text-slate-500',
};

// Стабильный цвет аватара по имени, чтобы люди различались взглядом
const _AVATAR_COLORS = [
  'bg-indigo-100 text-indigo-700', 'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',   'bg-sky-100 text-sky-700',
  'bg-rose-100 text-rose-700',     'bg-violet-100 text-violet-700',
];
function _avatarColor(name) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return _AVATAR_COLORS[h % _AVATAR_COLORS.length];
}
function _initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

async function _fillAssigneeSelect() {
  if (!_allUsers.length) {
    const users = await api('GET', '/users', undefined, true);
    _allUsers = (users || []).filter(u => u.is_active);
  }
  _renderAssigneeOptions();
}

function _refreshAssigneeSelect() {
  _renderAssigneeOptions();
}

function toggleAssigneePicker(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('assignee-picker-menu');
  if (!menu) return;
  const open = menu.style.display !== 'none';
  open ? closeAssigneePicker() : openAssigneePicker();
}

function openAssigneePicker() {
  const menu = document.getElementById('assignee-picker-menu');
  if (!menu) return;
  menu.style.display = '';
  _renderAssigneeOptions();
  const search = document.getElementById('assignee-search');
  if (search) { search.value = ''; setTimeout(() => search.focus(), 30); }
}

function closeAssigneePicker() {
  const menu = document.getElementById('assignee-picker-menu');
  if (menu) menu.style.display = 'none';
}

function _renderAssigneeOptions() {
  const box = document.getElementById('assignee-options');
  if (!box) return;

  const q = (document.getElementById('assignee-search')?.value || '').trim().toLowerCase();
  const already = new Set(selectedAssignees.map(a => String(a.user_id)));

  const list = _allUsers
    .filter(u => !already.has(String(u.user_id)))
    .filter(u => !q || u.username.toLowerCase().includes(q));

  if (!list.length) {
    box.innerHTML = `<p class="text-xs text-slate-400 text-center py-3">
      ${q ? 'Никого не найдено' : 'Все уже назначены'}</p>`;
    return;
  }

  box.innerHTML = list.map(u => {
    const role = ROLE_LABELS[u.role] || ROLE_LABELS.USER;
    const chip = ROLE_CHIP[u.role] || ROLE_CHIP.USER;
    return `
      <button type="button" onclick="pickAssignee('${u.user_id}')"
        class="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-indigo-50 transition-colors text-left">
        <span class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold
                     flex-shrink-0 ${_avatarColor(u.username)}">${esc(_initials(u.username))}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm text-slate-700 truncate">${esc(u.username)}</span>
        </span>
        ${u.online ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" title="В сети"></span>' : ''}
        <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 ${chip}">${role.text}</span>
      </button>`;
  }).join('');
}

function pickAssignee(userId) {
  const user = _allUsers.find(u => String(u.user_id) === String(userId));
  if (user) addAssignee(user.user_id, user.username);
  const search = document.getElementById('assignee-search');
  if (search) search.value = '';
  _renderAssigneeOptions();
}

function addAssignee(userId, username) {
  if (cardModalReadOnly || cardModalCommentOnly) return;
  if (selectedAssignees.some(a => String(a.user_id) === String(userId))) return;
  selectedAssignees.push({ user_id: userId, username });
  _renderAssigneeChips();
  _refreshAssigneeSelect();
}

function removeAssignee(userId) {
  if (cardModalReadOnly || cardModalCommentOnly) return;
  selectedAssignees = selectedAssignees.filter(a => String(a.user_id) !== String(userId));
  _renderAssigneeChips();
  _refreshAssigneeSelect();
}

function _renderAssigneeChips() {
  const box = document.getElementById('assignee-chips');
  if (!box) return;

  const locked = cardModalReadOnly || cardModalCommentOnly || _assigneesLocked;

  if (!selectedAssignees.length) {
    box.innerHTML = locked
      ? '<span class="text-xs text-slate-400 italic">Исполнители не назначены</span>'
      : '';
    return;
  }

  box.innerHTML = selectedAssignees.map(a => `
    <span class="inline-flex items-center gap-1.5 bg-white border border-slate-200 shadow-sm
                 rounded-full pl-1 ${locked ? 'pr-2.5' : 'pr-1'} py-1 text-xs">
      <span class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold
                   ${_avatarColor(a.username)}">${esc(_initials(a.username))}</span>
      <span class="text-slate-700 font-medium">${esc(a.username)}</span>
      ${locked ? '' : `<button type="button" onclick="removeAssignee('${a.user_id}')"
        class="w-4 h-4 rounded-full flex items-center justify-center text-slate-400
               hover:bg-red-50 hover:text-red-500 transition-colors" title="Убрать">&times;</button>`}
    </span>`).join('');
}

// Три режима модалки карточки:
//   ro=false, commentOnly=false — полное редактирование (автор задачи или админ)
//   ro=false, commentOnly=true  — только комментарии (назначен исполнителем)
//   ro=true                     — только просмотр (архив)
function _setStatusRadio(value) {
  const target = value || 'NOT_STARTED';
  document.querySelectorAll('input[name="card-status"]').forEach(r => {
    r.checked = r.value === target;
  });
}

function _getStatusRadio() {
  const checked = document.querySelector('input[name="card-status"]:checked');
  return checked ? checked.value : 'NOT_STARTED';
}

// Статус живёт по своим правилам: его меняет и исполнитель, который
// саму задачу править не может. Поэтому в режиме «только комментарии»
// блок статуса остаётся активным, а значение уходит отдельным запросом.
async function onStatusPicked() {
  const cardId = document.getElementById('card-edit-id').value;
  if (!cardId) return;                  // новая задача — уйдёт вместе с формой

  const card = findCardById(cardId);
  if (!canChangeStatus(card)) return;
  if (!cardModalCommentOnly) return;    // в полном режиме сохранится по «Сохранить»

  const picked = _getStatusRadio();
  const result = await api('PATCH', `/cards/${cardId}/status`, { status: picked });
  if (!result) {
    _setStatusRadio(card ? card.status : 'NOT_STARTED');   // откат
    return;
  }
  if (card) card.status = result.status;
  toast.success(`Статус: ${_statusMeta(result.status).label}`);
}

function openCardDescModal() {
  const small = document.getElementById('card-desc-input');
  const full = document.getElementById('card-desc-full-input');
  full.value = small.value;
  full.readOnly = small.readOnly;
  document.getElementById('modal-card-desc').showModal();
  if (!full.readOnly) full.focus();
}

function closeCardDescModal() {
  // На случай, если браузер не успел прогнать oninput перед закрытием.
  const full = document.getElementById('card-desc-full-input');
  document.getElementById('card-desc-input').value = full.value;
  document.getElementById('modal-card-desc').close();
}

function _applyCardModalMode(opts = {}) {
  const ro = cardModalReadOnly;
  const commentOnly = !ro && cardModalCommentOnly;

  // card-desc-input исключён отсюда: ему нужен readOnly, а не disabled,
  // иначе двойной клик для открытия полного текста перестанет работать —
  // disabled-элементы в браузерах вообще не порождают события мыши.
  ['card-title-input']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = ro || commentOnly;
    });
  const descEl = document.getElementById('card-desc-input');
  if (descEl) descEl.readOnly = ro || commentOnly;

  document.querySelectorAll('input[name="card-priority"]').forEach(r => {
    r.disabled = ro || commentOnly;
  });

  // Статус доступен шире остальных полей: автору, админу и исполнителям
  const statusAllowed = !ro && opts.canChangeStatus !== false;
  document.querySelectorAll('input[name="card-status"]').forEach(r => {
    r.disabled = !statusAllowed;
  });
  const statusGroup = document.getElementById('card-status-group');
  if (statusGroup) statusGroup.classList.toggle('opacity-50', !statusAllowed);
  const statusHint = document.getElementById('card-status-hint');
  // Подсказка нужна там, где статус сохраняется отдельно от формы
  if (statusHint) statusHint.style.display = (statusAllowed && commentOnly) ? '' : 'none';
  // Календарь дедлайна открывается только в режиме редактирования
  const dlTrigger = document.getElementById('deadline-trigger');
  if (dlTrigger) dlTrigger.disabled = ro || commentOnly;
  const dlClear = document.getElementById('card-deadline-clear');
  if (dlClear) dlClear.style.display = (ro || commentOnly) ? 'none' : '';
  if (ro || commentOnly) closeDeadlinePicker();

  // Состав исполнителей меняет только автор или админ
  // Состав исполнителей личной задачи неизменен: автор — единственный
  // исполнитель, поэтому пикер ему не показываем вовсе.
  const lockedAssignees = ro || commentOnly || opts.lockAssignees === true;
  _assigneesLocked = opts.lockAssignees === true;
  const picker = document.getElementById('assignee-picker');
  if (picker) picker.style.display = lockedAssignees ? 'none' : '';
  const assignHint = document.querySelector('#assignees-block p');
  if (assignHint) assignHint.style.display = lockedAssignees ? 'none' : '';
  closeAssigneePicker();

  // Загрузка вложений — автору и админу. Уже прикреплённые файлы
  // остаются видимыми и скачиваемыми в любом режиме кроме архива.
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) dropZone.style.display = (ro || commentOnly || opts.hideAttachments) ? 'none' : '';

  // Комментарии доступны всем, кто видит карточку. Закрыты только в архиве.
  const commentInput = document.querySelector('#comments-section .relative.group');
  if (commentInput) commentInput.style.display = (ro || opts.hideComments) ? 'none' : '';

  // «Сохранить» нечего, если менять можно только комментарии:
  // они отправляются отдельной кнопкой сразу.
  const saveBtn = document.querySelector('#modal-card button[onclick="submitCard()"]');
  if (saveBtn) saveBtn.style.display = (ro || commentOnly) ? 'none' : '';

  _renderAssigneeChips();
}

// Перерисовывает элементы интерфейса, зависящие от роли.
// Нужна, когда админ поменял роль, пока вкладка открыта.
function _applyRoleToUI() {
  const roleInfo = ROLE_LABELS[currentUser?.role] || ROLE_LABELS.USER;
  ['current-role', 'current-role-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = currentUser ? roleInfo.text : '';
      el.className = `text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleInfo.cls}`;
    }
  });
  ['btn-admin-panel', 'btn-admin-panel-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdmin() ? '' : 'none';
  });
  const projBtn = document.getElementById('btn-projects');
  if (projBtn) projBtn.style.display = currentUser ? '' : 'none';

  // Технический лог событий нужен только администратору

  // Общий дашборд остаётся только у админа
  if (isGlobalBoard() && !isAdmin()) {
    currentProject = null;
    sessionStorage.removeItem('last_project_id');
    loadBoard();
  }

  const addColBtn = document.getElementById('btn-add-col');
  if (addColBtn) {
    const allowed = currentUser && isManager() && !!currentProject?.can_manage;
    addColBtn.disabled = !allowed;
    addColBtn.style.display = allowed ? '' : 'none';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function openAddCard(colId) {
  const _col = columns.find(c => String(c.id) === String(colId));
  if (!canCreateInColumn(_col)) {
    return toast.warn('В этой категории вы не можете создавать задачи');
  }

  cardModalReadOnly = false;
  cardModalCommentOnly = false;
  selectedAssignees = [];
  _applyCardModalMode({ lockAssignees: !isManager() });
  await _fillAssigneeSelect();
  _renderAssigneeChips();

  document.getElementById('modal-card-title').textContent = 'Новая задача';
  document.getElementById('card-edit-id').value = '';
  document.getElementById('card-col-id').value = colId;
  document.getElementById('card-title-input').value = '';
  document.getElementById('card-desc-input').value = '';
  _setStatusRadio('NOT_STARTED');

  if (currentUser && !isManager()) {
    // Личная задача: исполнителем становится только автор, иначе
    // задача останется ничьей и пропадёт из его выдачи.
    selectedAssignees = [{ user_id: currentUser.user_id, username: currentUser.username }];
  } else {
    // Задачу ставит админ или постановщик: подставляем ответственных
    // проекта, включая унаследованных от родительского проекта.
    // Лишних можно убрать крестиком, добавить любого — через пикер.
    selectedAssignees = (currentProject?.members || []).map(m => ({
      user_id: m.user_id, username: m.username,
    }));
  }
  _renderAssigneeChips();
  _refreshAssigneeSelect();

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
  const card = findCardById(cardId);
  if (!card) return;

  const isArchived = card.is_archived || currentFilterMode === 'archived';

  // Режим карточки определяется ТОЛЬКО авторством, а не тем, на какой
  // доске она открыта. На сводке корневого проекта карточка ведёт себя
  // ровно так же, как на доске своего подпроекта.
  //   Архив                      → полный просмотр, ничего нельзя
  //   Автор задачи или админ     → полное редактирование
  //   Просто назначен исполнителем → только комментарии
  const isFullReadOnly   = isArchived;
  const isCommentOnly    = !isFullReadOnly && !canManageCard(card);

  cardModalReadOnly    = isFullReadOnly;
  cardModalCommentOnly = isCommentOnly;

  selectedAssignees = (card.assignees || []).map(a => ({ user_id: a.user_id, username: a.username }));
  await _fillAssigneeSelect();
  _renderAssigneeChips();

  document.getElementById('modal-card-title').textContent =
    isArchived ? '📦 Просмотр (архив)'
    : (isCommentOnly   ? '💬 Задача (можно комментировать)'
    :                    'Редактирование задачи');

  document.getElementById('card-edit-id').value = cardId;
  document.getElementById('card-col-id').value = card.column_id;
  document.getElementById('card-title-input').value = card.title;
  document.getElementById('card-desc-input').value = card.description || '';
  _setStatusRadio(card.status);
  // Личная задача исполнителя: состав менять нельзя
  const ownPersonalCard = !isManager() && String(card.created_by) === String(currentUser?.user_id);
  _applyCardModalMode({
    hideAttachments: isArchived,
    hideComments: isArchived,
    canChangeStatus: canChangeStatus(card),
    lockAssignees: ownPersonalCard,
  });

  const commentField = document.getElementById('card-new-comment');
  if (commentField) commentField.value = '';

  const priority = card.priority || "LOW";
  const radioToSelect = document.querySelector(`input[name="card-priority"][value="${priority}"]`);
  if (radioToSelect) radioToSelect.checked = true;

  setDeadlineValue(card.deadline || null);
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
  const _editId = document.getElementById('card-edit-id').value;
  
  if (_editId) {
    const _card = findCardById(_editId);
    // В режиме «только комментарии» кнопки «Сохранить» нет —
    // сюда можно попасть только в обход интерфейса.
    if (cardModalCommentOnly) {
      toast.warn('Изменять задачу может только её автор или администратор');
      return;
    }
    if (!canManageCard(_card)) {
      toast.warn('Изменять задачу может только её автор или администратор');
      return;
    }
  } else {
    const _newColId = document.getElementById('card-col-id').value;
    const _newCol = columns.find(c => String(c.id) === String(_newColId));
    if (!canCreateInColumn(_newCol)) {
      toast.warn('Создавать задачи может админ или постановщик');
      return;
    }
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
    const assigneeIds = selectedAssignees.map(a => a.user_id);

    const titleError = validateName(title, 200, 'Заголовок задачи');
    if (titleError) return toast.warn(titleError);


    // Просроченный дедлайн допустим: задачу заводят задним числом,
    // а у существующей срок мог истечь — это не повод не дать её сохранить.
    const deadline = document.getElementById('card-deadline-input').value || null;

    const priorityElement = document.querySelector('input[name="card-priority"]:checked');
    const priority = priorityElement ? priorityElement.value : 'LOW';

    const payload = {
      title,
      description: desc || null,
      status: _getStatusRadio(),
      assignee_ids: assigneeIds,
      deadline,
      priority,
    };

  let result;
    if (editId) {
      if (pendingDeletions.length > 0) {
        for (const attachId of pendingDeletions) {
          await api('DELETE', `/cards/attachments/${attachId}`);
        }
      }
      result = await api('PUT', `/cards/${editId}`, payload);
    } else {
      // created_by больше не передаём — сервер берёт автора из сессии
      result = await api('POST', '/cards', { ...payload, column_id: colId });
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
  if (!canManageCard(findCardById(id)))
    return toast.warn('Удалить задачу может только её автор или администратор');
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
  // Значение дедлайна ставит календарь, отдельный слушатель не нужен

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
      
      // Обе версии списка — десктопная и мобильная — должны показывать
      // восстановленное значение, иначе на телефоне будет «Все»,
      // хотя доска отфильтрована.
      ['sort-select', 'sort-select-m'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = currentSortMode;
      });
      ['filter-select', 'filter-select-m'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = currentFilterMode;
      });
    } catch (e) {
      console.warn("Ошибка восстановления настроек UI");
    }
  }

  const savedProject = sessionStorage.getItem('last_project_id');
  if (savedProject) currentProject = { id: savedProject };

  const me = await api('GET', '/users/me', undefined, true);

  try {
    if (me && me.user_id) {
      currentUser = me;
      await _uiLoggedIn(me);

      const cachedData = sessionStorage.getItem('last_board_state');
      if (cachedData) {
        try {
          const data = JSON.parse(cachedData);
          // Кеш чужого пользователя не показываем ни на мгновение
          if (data._owner && String(data._owner) !== String(me.user_id)) {
            throw new Error('cache belongs to another user');
          }
          columns = data.columns || [];
          cards = data.cards || [];
          onlineUsers = data.online_users || [];
          projects = data.projects || [];
          subSections = data.sections || [];
          if (data.project) currentProject = data.project;
          _renderProjectTree();
          _renderProjectHeader();
          
          renderBoard();
          if (typeof _renderOnlineUsers === 'function') _renderOnlineUsers();
        } catch (e) {
          sessionStorage.removeItem('last_board_state');
          columns = []; cards = []; subSections = [];
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

// ─────────────────────────────────────────────────────────────────────────────
// ПРОЕКТЫ: боковое меню, переключение, сводка подпроектов
// ─────────────────────────────────────────────────────────────────────────────
function toggleProjectDrawer() {
  const d = document.getElementById('project-drawer');
  const open = !d.classList.contains('-translate-x-full');
  open ? closeProjectDrawer() : openProjectDrawer();
}

function openProjectDrawer() {
  document.getElementById('project-drawer').classList.remove('-translate-x-full');
  document.getElementById('project-overlay').classList.remove('hidden');
}

function closeProjectDrawer() {
  document.getElementById('project-drawer').classList.add('-translate-x-full');
  document.getElementById('project-overlay').classList.add('hidden');
}

function _renderProjectTree() {
  const box = document.getElementById('project-tree');
  if (!box) return;

  const adminBox = document.getElementById('project-admin-actions');
  if (adminBox) adminBox.style.display = isAdmin() ? '' : 'none';

  const btn = document.getElementById('btn-projects');
  if (btn) btn.style.display = currentUser ? '' : 'none';

  // Общий дашборд по всем проектам — только администратору
  const globalItem = isAdmin() ? _globalBoardNode() : '';

  if (!projects.length) {
    box.innerHTML = globalItem + (isAdmin()
      ? '<p class="text-center text-slate-400 text-xs py-6">Проектов пока нет.<br>Создайте первый.</p>'
      : '<p class="text-center text-slate-400 text-xs py-6">Вам пока не назначен ни один проект</p>');
    return;
  }

  box.innerHTML = globalItem + projects.map(root => _projectNode(root, 0)).join('');
}

async function setGlobalUserFilter(userId) {
  globalUserFilter = userId || '';
  closeUserFilterPicker();
  renderBoard();
}

function toggleUserFilterPicker(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('user-filter-menu');
  if (!menu) return;
  menu.style.display !== 'none' ? closeUserFilterPicker() : openUserFilterPicker();
}

async function openUserFilterPicker() {
  const menu = document.getElementById('user-filter-menu');
  if (!menu) return;

  if (!_allUsers.length) {
    const users = await api('GET', '/users', undefined, true);
    _allUsers = (users || []).filter(u => u.is_active);
  }

  menu.style.display = '';
  const search = document.getElementById('user-filter-search');
  if (search) { search.value = ''; setTimeout(() => search.focus(), 30); }
  _renderUserFilterOptions();
}

function closeUserFilterPicker() {
  const menu = document.getElementById('user-filter-menu');
  if (menu) menu.style.display = 'none';
}

function _renderUserFilterOptions() {
  const box = document.getElementById('user-filter-options');
  if (!box) return;

  const q = (document.getElementById('user-filter-search')?.value || '').trim().toLowerCase();
  const list = _allUsers.filter(u => !q || u.username.toLowerCase().includes(q));

  // Сколько задач у каждого — считаем по тем же секциям, что видит админ
  const countFor = (uid) => subSections.reduce((acc, sec) => acc + (sec.cards || [])
    .filter(c => !c.is_archived && (c.assignees || []).some(a => String(a.user_id) === String(uid)))
    .length, 0);

  const resetRow = `
    <button type="button" onclick="setGlobalUserFilter('')"
      class="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-indigo-50 transition-colors text-left
             ${!globalUserFilter ? 'bg-indigo-50' : ''}">
      <span class="w-7 h-7 rounded-full border border-dashed border-slate-300 flex items-center
                   justify-center text-[11px] text-slate-400 flex-shrink-0">@</span>
      <span class="flex-1 text-sm text-slate-700">Все пользователи</span>
      ${!globalUserFilter ? '<span class="text-indigo-500 text-xs flex-shrink-0">✓</span>' : ''}
    </button>
    <div class="border-b border-slate-100 my-1"></div>`;

  if (!list.length) {
    box.innerHTML = (q ? '' : resetRow) +
      '<p class="text-xs text-slate-400 text-center py-3">Никого не найдено</p>';
    return;
  }

  box.innerHTML = (q ? '' : resetRow) + list.map(u => {
    const role = ROLE_LABELS[u.role] || ROLE_LABELS.USER;
    const chip = ROLE_CHIP[u.role] || ROLE_CHIP.USER;
    const active = String(globalUserFilter) === String(u.user_id);
    const n = countFor(u.user_id);
    return `
      <button type="button" onclick="setGlobalUserFilter('${u.user_id}')"
        class="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-indigo-50 transition-colors
               text-left ${active ? 'bg-indigo-50' : ''}">
        <span class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold
                     flex-shrink-0 ${_avatarColor(u.username)}">${esc(_initials(u.username))}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm text-slate-700 truncate">${esc(u.username)}</span>
        </span>
        ${n ? `<span class="bg-slate-100 text-slate-500 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0">${n}</span>` : ''}
        ${u.online ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" title="В сети"></span>' : ''}
        <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 ${chip}">${role.text}</span>
        ${active ? '<span class="text-indigo-500 text-xs flex-shrink-0">✓</span>' : ''}
      </button>`;
  }).join('');
}

async function _renderGlobalFilterBar() {
  const bar = document.getElementById('global-filter-bar');
  if (!bar) return;

  if (!isGlobalBoard() || !isAdmin()) {
    bar.style.display = 'none';
    globalUserFilter = '';
    closeUserFilterPicker();
    return;
  }

  bar.style.display = '';

  if (!_allUsers.length) {
    const users = await api('GET', '/users', undefined, true);
    _allUsers = (users || []).filter(u => u.is_active);
  }

  // Кнопка показывает выбранного человека так же, как он выглядит в списке
  const who = _allUsers.find(u => String(u.user_id) === String(globalUserFilter));
  const label = document.getElementById('user-filter-label');
  const avatar = document.getElementById('user-filter-avatar');

  if (label) label.textContent = who ? who.username : 'Все пользователи';
  if (avatar) {
    if (who) {
      avatar.textContent = _initials(who.username);
      avatar.className = `w-5 h-5 rounded-full flex items-center justify-center
                          text-[9px] font-bold flex-shrink-0 ${_avatarColor(who.username)}`;
    } else {
      avatar.textContent = '@';
      avatar.className = 'w-5 h-5 rounded-full border border-dashed border-slate-300 flex items-center'
                       + ' justify-center text-[10px] text-slate-400 flex-shrink-0';
    }
  }

  const btn = document.getElementById('user-filter-btn');
  if (btn) btn.classList.toggle('text-slate-700', !!who);

  const reset = document.getElementById('global-filter-reset');
  if (reset) reset.style.display = globalUserFilter ? '' : 'none';

  const counter = document.getElementById('global-filter-count');
  if (counter) {
    if (!globalUserFilter) {
      counter.textContent = '';
    } else {
      const f = getCardFilter();
      const n = subSections.reduce((acc, sec) => acc + (sec.cards || []).filter(f).length, 0);
      counter.textContent = `${n} ${_plural(n, 'задача', 'задачи', 'задач')}`;
    }
  }

  if (document.getElementById('user-filter-menu')?.style.display !== 'none') {
    _renderUserFilterOptions();
  }
}

function _globalBoardNode() {
  const active = isGlobalBoard();
  const journalActive = isJournalView();
  return `
    <div class="mb-1 pb-1 border-b border-slate-100">
      <button onclick="openJournal()"
        class="w-full flex items-center gap-2 rounded-lg pl-2 pr-2 py-1.5 text-left mb-0.5
               ${journalActive ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-slate-50 border border-transparent'}">
        <span class="text-xs flex-shrink-0">📜</span>
        <span class="truncate text-[13px] ${journalActive ? 'font-semibold text-indigo-700' : 'text-slate-700'}">Журнал действий</span>
      </button>
      <button onclick="switchProject('${GLOBAL_BOARD_ID}')"
        class="w-full flex items-center gap-2 rounded-lg pl-2 pr-2 py-1.5 text-left
               ${active ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-slate-50 border border-transparent'}">
        <span class="text-xs flex-shrink-0">🗂</span>
        <span class="truncate text-[13px] ${active ? 'font-semibold text-indigo-700' : 'text-slate-700'}">Все проекты</span>
      </button>
    </div>`;
}

function _projectNode(p, depth) {
  const active = currentProject && String(currentProject.id) === String(p.id);
  const pad = depth === 0 ? 'pl-2' : 'pl-7';
  const kids = (p.children || []).map(c => _projectNode(c, depth + 1)).join('');

  return `
    <div>
      <div class="group flex items-center gap-1 rounded-lg ${pad} pr-1 py-1.5
                  ${active ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-slate-50 border border-transparent'}">
        <button onclick="switchProject('${p.id}')"
          class="flex-1 text-left min-w-0 flex items-center gap-2">
          <span class="text-xs flex-shrink-0">${depth === 0 ? '📁' : '↳'}</span>
          <span class="truncate text-[13px] ${active ? 'font-semibold text-indigo-700' : 'text-slate-700'}"
                title="${esc(p.name)}">${esc(p.name)}</span>
          ${p.open_tasks ? `<span class="ml-auto flex-shrink-0 bg-slate-100 text-slate-500 text-[10px]
              font-medium px-1.5 py-0.5 rounded-full">${p.open_tasks}</span>` : ''}
        </button>
        ${isAdmin() ? `
          <button onclick="event.stopPropagation(); openProjectModal('${p.id}', null)"
            class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-indigo-600 px-1 text-xs"
            title="Настройки проекта">⚙</button>
          ${depth === 0 ? `<button onclick="event.stopPropagation(); openProjectModal(null, '${p.id}')"
            class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-emerald-600 px-1 text-sm leading-none"
            title="Добавить подпроект">+</button>` : ''}
        ` : ''}
      </div>
      ${kids}
    </div>`;
}

async function switchProject(projectId) {
  if (currentProject && String(currentProject.id) === String(projectId) && !isJournalView()) {
    closeProjectDrawer();
    return;
  }
  currentProject = { id: projectId };
  closeProjectDrawer();
  _applyJournalLayout();   // уходим с журнала — возвращаем доску
  await loadBoard();
}

function _renderProjectHeader() {
  const title = document.getElementById('board-title');
  const crumb = document.getElementById('board-breadcrumb');
  if (!title) return;

  if (!currentProject) {
    title.textContent = 'Доска';
    if (crumb) crumb.textContent = '';
    return;
  }

  title.textContent = currentProject.name || 'Доска';

  if (crumb) {
    let text = '';
    if (isGlobalBoard()) {
      text = `${subSections.length} ${_plural(subSections.length, 'доска', 'доски', 'досок')} по всем проектам`;
    } else if (currentProject.parent_id) {
      const parent = projects.find(p => String(p.id) === String(currentProject.parent_id));
      if (parent) text = `${parent.name} → подпроект`;
    } else if (subSections.length) {
      text = `включая ${subSections.length} ${_plural(subSections.length, 'подпроект', 'подпроекта', 'подпроектов')}`;
    }
    crumb.textContent = text;
  }

  // Колонки и задачи создаются только там, где есть право вести проект
  const canManageProject = !!(currentProject && currentProject.can_manage);
  const addColBtn = document.getElementById('btn-add-col');
  if (addColBtn) {
    const allowed = currentUser && isManager() && canManageProject;
    addColBtn.disabled = !allowed;
    addColBtn.style.display = allowed ? '' : 'none';
  }
}

function _plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// ── Сводка подпроектов на корневом проекте ───────────────────────────
// Колонки у каждого узла свои, поэтому карточки подпроектов нельзя
// разложить по колонкам родителя. Показываем их отдельными досками
// только для чтения — перетаскивание между проектами запрещено.
function _renderSubprojectSections() {
  const host = document.getElementById('subproject-sections');
  if (!host) return;

  if (!subSections.length || currentFilterMode === 'archived') {
    host.innerHTML = (isGlobalBoard() && currentFilterMode !== 'archived')
      ? '<p class="text-sm text-slate-400 py-6 text-center">Проектов с досками пока нет</p>'
      : '';
    return;
  }

  const filter = getCardFilter();
  const sorter = getCardSorted();

  // При выборке по пользователю проекты без его задач только мешают
  const shown = (globalUserFilter && isGlobalBoard())
    ? subSections.filter(sec => (sec.cards || []).some(filter))
    : subSections;

  if (!shown.length) {
    host.innerHTML = '<p class="text-sm text-slate-400 py-6 text-center">У этого пользователя нет задач</p>';
    return;
  }

  host.innerHTML = shown.map(sec => {
    const cols = [...(sec.columns || [])].sort((a, b) => a.position - b.position);
    const total = (sec.cards || []).filter(filter).length;

    const board = cols.map(col => {
      const list = (sec.cards || [])
        .filter(c => String(c.column_id) === String(col.id))
        .filter(filter)
        .sort(sorter);

      return `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col
                    sm:min-w-[260px] sm:max-w-[260px] w-full">
          <div class="flex justify-between items-center px-3 pt-2.5 pb-2 border-b border-slate-100">
            <h4 class="font-medium text-slate-600 truncate text-xs">${esc(col.name)}</h4>
            <span class="bg-slate-100 text-slate-500 text-[10px] px-1.5 py-0.5 rounded-full">${list.length}</span>
          </div>
          <div class="px-2 py-2 flex flex-col gap-2 min-h-[40px]">
            ${list.map(c => _renderCard(c)).join('') ||
              '<p class="text-[11px] text-slate-300 text-center py-2">пусто</p>'}
          </div>
        </div>`;
    }).join('');

    return `
      <section>
        <div class="flex items-center gap-2 mb-2">
          <span class="text-xs">${sec.project.parent_name ? '↳' : '📁'}</span>
          <button onclick="switchProject('${sec.project.id}')"
            class="text-sm font-semibold text-slate-700 hover:text-indigo-600 transition-colors">
            ${sec.project.parent_name ? `<span class="text-slate-400 font-normal">${esc(sec.project.parent_name)} / </span>` : ''}${esc(sec.project.name)}
          </button>
          <span class="bg-slate-100 text-slate-500 text-[10px] px-1.5 py-0.5 rounded-full">${total}</span>
          <span class="text-[10px] text-slate-400">открыть, чтобы работать с доской</span>
        </div>
        <div class="flex gap-3 overflow-x-auto pb-2 items-start">
          ${board || '<p class="text-xs text-slate-400 py-2">В подпроекте ещё нет категорий</p>'}
        </div>
      </section>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОЕКТЫ: создание и настройка (только ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
function _findProject(id) {
  for (const root of projects) {
    if (String(root.id) === String(id)) return root;
    for (const child of (root.children || [])) {
      if (String(child.id) === String(id)) return child;
    }
  }
  return null;
}

async function openProjectModal(projectId, parentId) {
  if (!isAdmin()) return toast.warn('Проекты создаёт администратор');

  const existing = projectId ? _findProject(projectId) : null;
  selectedOwners = existing ? (existing.owners || []).map(o => ({ ...o })) : [];
  selectedMembers = existing ? (existing.members || []).map(m => ({ ...m })) : [];

  document.getElementById('project-edit-id').value = projectId || '';
  document.getElementById('project-parent-id').value = parentId || '';
  document.getElementById('project-name').value = existing ? existing.name : '';
  document.getElementById('project-description').value = existing ? (existing.description || '') : '';

  document.getElementById('modal-project-title').textContent =
    existing ? 'Настройки проекта' : (parentId ? 'Новый подпроект' : 'Новый проект');

  const delBtn = document.getElementById('project-delete-btn');
  if (delBtn) delBtn.style.display = existing ? '' : 'none';

  // Ответственный назначается на проект целиком; у подпроекта он наследуется
  // Настройки проекта и подпроекта одинаковы: состав задаётся на любом
  // уровне, при этом участники корня наследуются его подпроектами.
  const ownersBlock = document.getElementById('project-owners-block');
  if (ownersBlock) ownersBlock.style.display = '';

  _renderOwnerChips();
  _renderMemberChips();
  await _fillOwnerOptions();
  await _fillMemberOptions();

  document.getElementById('modal-project').showModal();
  setTimeout(() => document.getElementById('project-name').focus(), 50);
}

async function _fillOwnerOptions() {
  const sel = document.getElementById('project-owner-select');
  if (!sel) return;
  const users = await api('GET', '/admin/users', undefined, true);
  const eligible = (users || []).filter(u =>
    u.is_active && (u.role === 'TEAM_LEAD' || u.role === 'ADMIN'));

  sel.innerHTML = '<option value="">Добавить постановщика…</option>' +
    eligible
      .filter(u => !selectedOwners.some(o => String(o.user_id) === String(u.user_id)))
      .map(u => `<option value="${u.user_id}|${esc(u.username)}">${esc(u.username)}</option>`)
      .join('');
}

async function _fillMemberOptions() {
  const sel = document.getElementById('project-member-select');
  if (!sel) return;
  const users = await api('GET', '/admin/users', undefined, true);
  // Ответственным можно назначить только пользователя с ролью «Исполнитель»
  const eligible = (users || []).filter(u => u.is_active && u.role === 'USER');

  sel.innerHTML = '<option value="">Добавить исполнителя…</option>' +
    eligible
      .filter(u => !selectedMembers.some(m => String(m.user_id) === String(u.user_id)))
      .map(u => `<option value="${u.user_id}|${esc(u.username)}">${esc(u.username)}</option>`)
      .join('');
}

function addProjectMember(value) {
  if (!value) return;
  const [id, username] = value.split('|');
  if (selectedMembers.some(m => String(m.user_id) === String(id))) return;
  selectedMembers.push({ user_id: id, username });
  _renderMemberChips();
  _fillMemberOptions();
}

function removeProjectMember(userId) {
  selectedMembers = selectedMembers.filter(m => String(m.user_id) !== String(userId));
  _renderMemberChips();
  _fillMemberOptions();
}

function _renderMemberChips() {
  const box = document.getElementById('project-member-chips');
  if (!box) return;
  box.innerHTML = selectedMembers.map(m => `
    <span class="inline-flex items-center gap-1.5 bg-white border border-slate-200 shadow-sm
                 rounded-full pl-1 pr-1 py-1 text-xs">
      <span class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold
                   ${_avatarColor(m.username)}">${esc(_initials(m.username))}</span>
      <span class="text-slate-700 font-medium">${esc(m.username)}</span>
      <button type="button" onclick="removeProjectMember('${m.user_id}')"
        class="w-4 h-4 rounded-full flex items-center justify-center text-slate-400
               hover:bg-red-50 hover:text-red-500 transition-colors" title="Убрать">&times;</button>
    </span>`).join('');
}

function addProjectOwner(value) {
  if (!value) return;
  const [id, username] = value.split('|');
  if (selectedOwners.some(o => String(o.user_id) === String(id))) return;
  selectedOwners.push({ user_id: id, username });
  _renderOwnerChips();
  _fillOwnerOptions();
}

function removeProjectOwner(userId) {
  selectedOwners = selectedOwners.filter(o => String(o.user_id) !== String(userId));
  _renderOwnerChips();
  _fillOwnerOptions();
}

function _renderOwnerChips() {
  const box = document.getElementById('project-owner-chips');
  if (!box) return;
  box.innerHTML = selectedOwners.map(o => `
    <span class="inline-flex items-center gap-1 bg-violet-50 text-violet-700 border border-violet-200
                 rounded-full pl-2.5 pr-1 py-0.5 text-xs font-medium">
      ${esc(o.username)}
      <button type="button" onclick="removeProjectOwner('${o.user_id}')"
        class="text-violet-400 hover:text-red-500 leading-none text-sm px-0.5">&times;</button>
    </span>`).join('');
}

async function submitProject() {
  const id = document.getElementById('project-edit-id').value;
  const parentId = document.getElementById('project-parent-id').value;
  const name = document.getElementById('project-name').value.trim();
  const description = document.getElementById('project-description').value.trim() || null;

  const projectNameError = validateName(name, 150, 'Название проекта');
  if (projectNameError) return toast.warn(projectNameError);

  const ownerIds = selectedOwners.map(o => o.user_id);
  const memberIds = selectedMembers.map(m => m.user_id);
  let result;

  // Проект и подпроект настраиваются одинаково: состав задаётся
  // на любом уровне, поэтому отдельной ветки для подпроекта нет.
  if (id) {
    result = await api('PATCH', `/projects/${id}`, {
      name, description, owner_ids: ownerIds, member_ids: memberIds,
    });
  } else {
    const payload = { name, description, owner_ids: ownerIds, member_ids: memberIds };
    if (parentId) payload.parent_id = parentId;
    result = await api('POST', '/projects', payload);
  }

  if (!result) return;
  document.getElementById('modal-project').close();
  toast.success(id ? 'Проект обновлён' : 'Проект создан');

  if (!id) currentProject = { id: result.id };
  await loadBoard();
}

async function deleteProject() {
  const id = document.getElementById('project-edit-id').value;
  if (!id) return;
  const p = _findProject(id);
  if (!confirm(`Удалить проект «${p ? p.name : ''}»? Подпроекты и их категории будут удалены вместе с ним.`)) return;

  const res = await api('DELETE', `/projects/${id}`);
  if (res === null) return;

  document.getElementById('modal-project').close();
  toast.success('Проект удалён');
  if (currentProject && String(currentProject.id) === String(id)) currentProject = null;
  await loadBoard();
}

// ─────────────────────────────────────────────────────────────────────────────
// ЖУРНАЛ ДЕЙСТВИЙ (только ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_META = {
  CARD_CREATED:       { icon: '➕', label: 'Задача создана',        cls: 'bg-emerald-50 text-emerald-700' },
  CARD_EDITED:        { icon: '✏️', label: 'Задача изменена',       cls: 'bg-blue-50 text-blue-700' },
  CARD_MOVED:         { icon: '↔️', label: 'Задача перемещена',     cls: 'bg-sky-50 text-sky-700' },
  CARD_ASSIGNED:      { icon: '👥', label: 'Исполнители',           cls: 'bg-indigo-50 text-indigo-700' },
  CARD_ARCHIVED:      { icon: '📦', label: 'В архив',               cls: 'bg-amber-50 text-amber-700' },
  CARD_RESTORED:      { icon: '♻️', label: 'Из архива',             cls: 'bg-amber-50 text-amber-700' },
  CARD_DELETED:       { icon: '🗑', label: 'Задача удалена',        cls: 'bg-red-50 text-red-600' },
  COMMENT_ADDED:      { icon: '💬', label: 'Комментарий',           cls: 'bg-slate-100 text-slate-600' },
  COMMENT_EDITED:     { icon: '💬', label: 'Комментарий изменён',   cls: 'bg-slate-100 text-slate-600' },
  COMMENT_DELETED:    { icon: '💬', label: 'Комментарий удалён',    cls: 'bg-red-50 text-red-600' },
  ATTACHMENT_ADDED:   { icon: '📎', label: 'Файл добавлен',         cls: 'bg-slate-100 text-slate-600' },
  ATTACHMENT_DELETED: { icon: '📎', label: 'Файл удалён',           cls: 'bg-red-50 text-red-600' },
  COLUMN_CREATED:     { icon: '🗂', label: 'Категория создана',     cls: 'bg-emerald-50 text-emerald-700' },
  COLUMN_UPDATED:     { icon: '🗂', label: 'Категория изменена',    cls: 'bg-blue-50 text-blue-700' },
  COLUMN_DELETED:     { icon: '🗂', label: 'Категория удалена',     cls: 'bg-red-50 text-red-600' },
  PROJECT_CREATED:    { icon: '📁', label: 'Проект создан',         cls: 'bg-emerald-50 text-emerald-700' },
  PROJECT_UPDATED:    { icon: '📁', label: 'Проект изменён',        cls: 'bg-blue-50 text-blue-700' },
  PROJECT_DELETED:    { icon: '📁', label: 'Проект удалён',         cls: 'bg-red-50 text-red-600' },
  USER_CREATED:       { icon: '👤', label: 'Пользователь создан',   cls: 'bg-emerald-50 text-emerald-700' },
  USER_UPDATED:       { icon: '👤', label: 'Пользователь изменён',  cls: 'bg-blue-50 text-blue-700' },
  USER_DEACTIVATED:   { icon: '🚫', label: 'Доступ отключён',       cls: 'bg-red-50 text-red-600' },
  USER_LOGIN:         { icon: '🔑', label: 'Вход',                  cls: 'bg-slate-100 text-slate-500' },
  USER_LOGOUT:        { icon: '🚪', label: 'Выход',                 cls: 'bg-slate-100 text-slate-500' },
};

function _journalMeta(type) {
  return EVENT_META[type] || { icon: '•', label: type, cls: 'bg-slate-100 text-slate-600' };
}

async function openJournal() {
  if (!isAdmin()) return toast.warn('Журнал действий доступен только администратору');
  currentProject = { id: JOURNAL_ID, name: 'Журнал действий', is_root: false, can_manage: false };
  journalOffset = 0;
  closeProjectDrawer();
  sessionStorage.setItem('last_project_id', JOURNAL_ID);
  _applyJournalLayout();
  _renderProjectTree();
  await _fillJournalUsers();
  await loadJournal();
}

// Журнал занимает то же место, что и доска: прячем всё лишнее,
// иначе под таблицей событий останутся колонки прошлого проекта.
function _applyJournalLayout() {
  const on = isJournalView();
  const board = document.getElementById('board');
  const sections = document.getElementById('subproject-sections');
  const filterBar = document.getElementById('global-filter-bar');
  const journal = document.getElementById('journal-view');

  if (board) board.style.display = on ? 'none' : '';
  if (sections) sections.style.display = on ? 'none' : '';
  if (on && filterBar) filterBar.style.display = 'none';
  if (journal) journal.style.display = on ? '' : 'none';

  const title = document.getElementById('board-title');
  const crumb = document.getElementById('board-breadcrumb');
  if (on) {
    if (title) title.textContent = 'Журнал действий';
    if (crumb) crumb.textContent = 'вся история изменений в системе';
  }

  // Список онлайна и кнопка колонки к журналу отношения не имеют
  const onlineBar = document.getElementById('online-bar');
  if (onlineBar) onlineBar.style.display = on ? 'none' : '';

  const addColBtn = document.getElementById('btn-add-col');
  if (on && addColBtn) addColBtn.style.display = 'none';
}

async function _fillJournalUsers() {
  const sel = document.getElementById('journal-user');
  if (!sel) return;
  if (!_allUsers.length) {
    const users = await api('GET', '/users', undefined, true);
    _allUsers = (users || []).filter(u => u.is_active);
  }
  const current = sel.value;
  sel.innerHTML = '<option value="">Все пользователи</option>' +
    _allUsers.map(u => `<option value="${u.user_id}">${esc(u.username)}</option>`).join('');
  sel.value = current;
}

function _journalQuery() {
  const p = new URLSearchParams();
  p.set('limit', JOURNAL_LIMIT);
  p.set('offset', journalOffset);

  const q = document.getElementById('journal-search')?.value.trim();
  const cat = document.getElementById('journal-category')?.value;
  const user = document.getElementById('journal-user')?.value;
  const from = document.getElementById('journal-from')?.value;
  const to = document.getElementById('journal-to')?.value;

  if (q) p.set('q', q);
  if (cat) p.set('category', cat);
  if (user) p.set('user_id', user);
  if (from) p.set('date_from', `${from}T00:00:00`);
  // Верхняя граница включительно: конец выбранного дня
  if (to) p.set('date_to', `${to}T23:59:59`);
  return p.toString();
}

async function loadJournal() {
  const list = document.getElementById('journal-list');
  if (!list) return;
  list.innerHTML = '<p class="text-center text-slate-400 text-sm py-8">Загрузка…</p>';

  const data = await api('GET', `/events/journal?${_journalQuery()}`);
  if (!data) {
    list.innerHTML = '<p class="text-center text-red-400 text-sm py-8">Не удалось загрузить журнал</p>';
    return;
  }

  journalTotal = data.total;
  _renderJournal(data.items);
  _renderJournalPager();
}

function _renderJournal(items) {
  const list = document.getElementById('journal-list');
  if (!list) return;

  const totalEl = document.getElementById('journal-total');
  if (totalEl) totalEl.textContent = journalTotal
    ? `${journalTotal} ${_plural(journalTotal, 'запись', 'записи', 'записей')}`
    : '';

  if (!items.length) {
    list.innerHTML = '<p class="text-center text-slate-400 text-sm py-8">Ничего не найдено</p>';
    return;
  }

  let lastDay = null;
  const rows = [];

  items.forEach(e => {
    const d = new Date(e.created_at);
    const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    if (day !== lastDay) {
      lastDay = day;
      rows.push(`<div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide pt-3 pb-1">${esc(day)}</div>`);
    }

    const meta = _journalMeta(e.event_type);
    const who = e.actor_username || 'система';
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    const tags = [];
    if (e.project_name) tags.push(`<span class="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">📁 ${esc(e.project_name)}</span>`);
    if (e.column_name) tags.push(`<span class="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">🗂 ${esc(e.column_name)}</span>`);
    if (e.target_username) tags.push(`<span class="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">👤 ${esc(e.target_username)}</span>`);

    rows.push(`
      <div class="flex items-start gap-3 bg-white border border-slate-200 rounded-xl px-3 py-2.5">
        <span class="text-base leading-none pt-0.5 flex-shrink-0">${meta.icon}</span>

        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-2 mb-0.5">
            <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${meta.cls}">${esc(meta.label)}</span>
            <span class="inline-flex items-center gap-1.5">
              <span class="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold
                           ${_avatarColor(who)}">${esc(_initials(who))}</span>
              <span class="text-xs font-medium text-slate-600">${esc(who)}</span>
            </span>
            <span class="text-[11px] text-slate-400">${time}</span>
          </div>
          <p class="text-sm text-slate-700 break-words">${esc(e.message)}</p>
          ${tags.length ? `<div class="flex flex-wrap gap-1 mt-1.5">${tags.join('')}</div>` : ''}
        </div>
      </div>`);
  });

  list.innerHTML = rows.join('');
}

function _renderJournalPager() {
  const prev = document.getElementById('journal-prev');
  const next = document.getElementById('journal-next');
  const info = document.getElementById('journal-page');

  const page = Math.floor(journalOffset / JOURNAL_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(journalTotal / JOURNAL_LIMIT));

  if (prev) prev.disabled = journalOffset === 0;
  if (next) next.disabled = journalOffset + JOURNAL_LIMIT >= journalTotal;
  if (info) info.textContent = `${page} из ${pages}`;
}

async function journalPage(direction) {
  const next = journalOffset + direction * JOURNAL_LIMIT;
  if (next < 0 || next >= journalTotal) return;
  journalOffset = next;
  await loadJournal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function applyJournalFilters() {
  journalOffset = 0;
  await loadJournal();
}

async function resetJournalFilters() {
  ['journal-search', 'journal-from', 'journal-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['journal-category', 'journal-user'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  await applyJournalFilters();
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PANEL (только роль ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
let adminUsers = [];

async function openAdminPanel() {
  if (!isAdmin()) return toast.warn('Доступно только администратору');

  document.getElementById('admin-new-username').value = '';
  document.getElementById('admin-new-password').value = '';
  document.getElementById('admin-new-role').value = 'USER';
  document.getElementById('modal-admin').showModal();
  await loadAdminUsers();
}

async function loadAdminUsers() {
  const box = document.getElementById('admin-users-list');
  box.innerHTML = '<p class="text-center text-slate-400 text-xs py-4">Загрузка…</p>';

  const users = await api('GET', '/admin/users');
  if (!users) {
    box.innerHTML = '<p class="text-center text-red-400 text-xs py-4">Не удалось загрузить список</p>';
    return;
  }
  adminUsers = users;
  _renderAdminUsers();
}

function _renderAdminUsers() {
  const box = document.getElementById('admin-users-list');
  if (!adminUsers.length) {
    box.innerHTML = '<p class="text-center text-slate-400 text-xs py-4">Пользователей нет</p>';
    return;
  }

  box.innerHTML = adminUsers.map(u => {
    const role = ROLE_LABELS[u.role] || ROLE_LABELS.USER;
    const isMe = String(u.user_id) === String(currentUser?.user_id);
    const dimmed = u.is_active ? '' : 'opacity-50';

    return `
      <div class="flex flex-wrap items-center gap-2 border border-slate-200 rounded-xl px-3 py-2 ${dimmed}">
        <span class="w-2 h-2 rounded-full flex-shrink-0 ${u.online ? 'bg-emerald-500' : 'bg-slate-300'}"
              title="${u.online ? 'В сети' : 'Не в сети'}"></span>

        <span class="font-medium text-sm text-slate-800 truncate flex-1 min-w-[100px]">
          ${esc(u.username)}
          ${isMe ? '<span class="text-[10px] text-slate-400 font-normal">(вы)</span>' : ''}
          ${!u.is_active ? '<span class="text-[10px] text-red-500 font-normal">деактивирован</span>' : ''}
        </span>

        <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${role.cls}">${role.text}</span>

        <select onchange="changeUserRole('${u.user_id}', this.value)" ${isMe ? 'disabled' : ''}
          class="border border-slate-300 rounded-lg px-2 py-1 text-xs bg-white disabled:opacity-40 disabled:cursor-not-allowed">
          <option value="USER"      ${u.role === 'USER' ? 'selected' : ''}>Пользователь</option>
          <option value="TEAM_LEAD" ${u.role === 'TEAM_LEAD' ? 'selected' : ''}>Тим лидер</option>
          <option value="ADMIN"     ${u.role === 'ADMIN' ? 'selected' : ''}>Администратор</option>
        </select>

        <button onclick="resetUserPassword('${u.user_id}', '${esc(u.username)}')"
          class="text-xs text-slate-500 hover:text-indigo-600 border border-slate-200 rounded-lg px-2 py-1"
          title="Задать новый пароль">🔑</button>

        ${u.is_active
          ? `<button onclick="setUserActive('${u.user_id}', false)" ${isMe ? 'disabled' : ''}
               class="text-xs text-slate-400 hover:text-red-500 border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
               title="Деактивировать">✕</button>`
          : `<button onclick="setUserActive('${u.user_id}', true)"
               class="text-xs text-emerald-600 hover:text-emerald-700 border border-emerald-200 rounded-lg px-2 py-1"
               title="Вернуть доступ">↺</button>`}
      </div>`;
  }).join('');
}

async function submitNewUser() {
  const username = document.getElementById('admin-new-username').value.trim();
  const password = document.getElementById('admin-new-password').value;
  const role     = document.getElementById('admin-new-role').value;

  if (!username) return toast.warn('Укажите логин');
  if (password.length < 6) return toast.warn('Пароль: минимум 6 символов');

  const created = await api('POST', '/admin/users', { username, password, role });
  if (!created) return;

  document.getElementById('admin-new-username').value = '';
  document.getElementById('admin-new-password').value = '';
  toast.success(`Пользователь ${created.username} создан`);
  await loadAdminUsers();
}

async function changeUserRole(userId, role) {
  const updated = await api('PATCH', `/admin/users/${userId}`, { role });
  if (!updated) { await loadAdminUsers(); return; }
  toast.success(`Роль изменена: ${(ROLE_LABELS[role] || {}).text || role}`);
  // Смена роли обрывает сессии пользователя — он будет вынужден войти заново
  await loadAdminUsers();
}

async function resetUserPassword(userId, username) {
  const password = prompt(`Новый пароль для «${username}» (минимум 6 символов):`);
  if (password === null) return;
  if (password.length < 6) return toast.warn('Пароль: минимум 6 символов');

  const updated = await api('PATCH', `/admin/users/${userId}`, { password });
  if (!updated) return;
  toast.success('Пароль обновлён, активные сессии сброшены');
}

async function setUserActive(userId, isActive) {
  if (!isActive && !confirm('Деактивировать пользователя? Он не сможет войти, а его сессии будут сброшены.')) return;

  const updated = await api('PATCH', `/admin/users/${userId}`, { is_active: isActive });
  if (!updated) { await loadAdminUsers(); return; }
  toast.success(isActive ? 'Доступ восстановлен' : 'Пользователь деактивирован');
  await loadAdminUsers();
}

document.addEventListener('click', (e) => {
  // Клик мимо выпадающего списка исполнителей закрывает его
  const picker = document.getElementById('assignee-picker');
  if (picker && !picker.contains(e.target)) closeAssigneePicker();

  const ufPicker = document.getElementById('user-filter-picker');
  if (ufPicker && !ufPicker.contains(e.target)) closeUserFilterPicker();

  const dlPicker = document.getElementById('deadline-picker');
  if (dlPicker && !dlPicker.contains(e.target)) closeDeadlinePicker();

  if (e.target.tagName !== 'DIALOG') return;
  const r = e.target.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) e.target.close();
});

// Фильтры журнала: текст с задержкой, остальное сразу.
// Вешаем на сами элементы, а не через onchange в разметке —
// иначе фильтр применяется только при следующем открытии вкладки.
document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('journal-search');
  if (search) {
    search.addEventListener('input', () => {
      clearTimeout(journalSearchTimer);
      journalSearchTimer = setTimeout(applyJournalFilters, 350);
    });
    // Enter применяет фильтр немедленно, не дожидаясь паузы
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(journalSearchTimer);
        applyJournalFilters();
      }
    });
  }

  ['journal-category', 'journal-user', 'journal-from', 'journal-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applyJournalFilters);
  });
});

document.addEventListener('DOMContentLoaded', () => {
  const modalCard = document.getElementById('modal-card');
  if (modalCard) {
    modalCard.addEventListener('close', () => {
      cardModalReadOnly = false;
      cardModalCommentOnly = false;
      selectedAssignees = [];
      const chips = document.getElementById('assignee-chips');
      if (chips) chips.innerHTML = '';
      const assignHint = document.querySelector('#assignees-block p');
      if (assignHint) assignHint.style.display = '';
      const fields = ['card-title-input'];
      fields.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
      const descEl = document.getElementById('card-desc-input');
      if (descEl) descEl.readOnly = false;
      document.querySelectorAll('input[name="card-priority"]').forEach(r => { r.disabled = false; });
      const dropZone = document.getElementById('drop-zone');
      if (dropZone) dropZone.style.display = '';
      const commentInput = document.querySelector('#comments-section .relative.group');
      if (commentInput) commentInput.style.display = '';
      const saveBtn = document.querySelector('#modal-card button[onclick="submitCard()"]');
      if (saveBtn) saveBtn.style.display = '';
    });
  }
});

(function () {
  let lockCount = 0;

  function refreshScrollLock() {
    const anyOpen = !!document.querySelector('dialog[open]');
    if (anyOpen && lockCount === 0) {
      lockCount = 1;
      document.body.style.overflow = 'hidden';
    } else if (!anyOpen && lockCount !== 0) {
      lockCount = 0;
      document.body.style.overflow = '';
    }
  }

  function observeDialog(dialog) {
    new MutationObserver(refreshScrollLock)
      .observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('dialog').forEach(observeDialog);
    refreshScrollLock();
  });
})();