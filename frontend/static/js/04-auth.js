'use strict';
// Роли, права на клиенте, вход и выход.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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
// Руководитель проекта — не роль, а назначение в настройках проекта:
// права на доску приходят с сервера флагом currentProject.can_manage;
// USER — видит только свои задачи и двигает их по разрешённым категориям.
const ROLE_LABELS = {
  ADMIN:     { text: 'Админ',     cls: 'bg-rose-100 text-rose-700' },
  TEAM_LEAD: { text: 'Постановщик', cls: 'bg-violet-100 text-violet-700' },
  USER:      { text: 'Исполнитель', cls: 'bg-slate-100 text-slate-600' },
};

function isAdmin()   { return currentUser?.role === 'ADMIN'; }
function isManager() { return currentUser?.role === 'ADMIN' || currentUser?.role === 'TEAM_LEAD'; }

// Ведёт ли пользователь доску открытого проекта: админ, постановщик или
// руководитель проекта. Руководителем назначают в настройках проекта
// человека с любой ролью, поэтому опираемся на флаг сервера can_manage.
function canLeadBoard() { return isManager() || !!currentProject?.can_manage; }

// Ограничен ли выбор исполнителей: у админа и постановщика ограничений нет,
// у остальных его задаёт назначение в проекте (см. _loadAssigneePool).
function hasFreeAssigneeChoice() { return isManager(); }

// Право менять саму задачу принадлежит админу и АВТОРУ задачи —
// независимо от его роли. Обычный сотрудник, заведший себе задачу,
// распоряжается ею так же, как постановщик своей.
// Постановщик, которого лишь назначили исполнителем чужой задачи,
// её не редактирует — только комментирует и двигает.
// Правило совпадает с CardService._can_manage на сервере.
function canManageCard(card) {
  if (!currentUser || !card) return false;
  if (isAdmin()) return true;
  return String(card.created_by) === String(currentUser.user_id);
}

// Вложения — единственная часть карточки, доступная шире остального:
// ими распоряжаются админ, автор задачи и любой её исполнитель.
// Исполнителю это нужно, чтобы приложить результат работы, не имея
// при этом права переписывать условие. Совпадает с
// CardService._can_edit_attachments на сервере.
function canEditAttachments(card) {
  if (!currentUser || !card) return false;
  if (isAdmin()) return true;
  const meId = String(currentUser.user_id);
  if (String(card.created_by) === meId) return true;
  return (card.assignees || []).some(a => String(a.user_id) === meId);
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
  // Админ, постановщик или руководитель этого проекта
  if (currentProject?.can_manage) return true;
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