'use strict';
// Модалка задачи: исполнители, режимы, роль в UI.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNEE PICKER — свой выпадающий список вместо системного <select>:
// системный нельзя стилизовать и в нём не показать роль и аватар.
// ─────────────────────────────────────────────────────────────────────────────
let _allUsers = [];  // кеш активных пользователей на время сессии
// Кого можно назначать в открытой задаче. null — без ограничений
// (админ, постановщик). Для руководителя — Set из user_id, который
// отдаёт сервер: постановщики и ответственные проекта, а руководителю
// всего проекта ещё и руководители подпроектов.
let _assigneePool = null;

const ROLE_CHIP = {
  ADMIN:     'bg-rose-50 text-rose-600',
  TEAM_LEAD: 'bg-violet-50 text-violet-600',
  USER:      'bg-slate-100 text-slate-500',
  PROJECT_MANAGER: 'bg-amber-50 text-amber-700',
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

// Ограничение выбора исполнителей для руководителя. Проверка всё равно
// идёт на сервере — здесь только чтобы не предлагать заведомо запрещённых.
async function _loadAssigneePool(projectId) {
  _assigneePool = null;
  if (!isProjectManager() || !projectId) return;
  const data = await api('GET', `/projects/${projectId}/assignable`, undefined, true);
  if (data && data.restricted) {
    _assigneePool = new Set((data.users || []).map(u => String(u.user_id)));
    // Пул может содержать тех, кого ещё нет в кеше (кеш живёт всю сессию)
    for (const u of data.users || []) {
      if (!_allUsers.some(x => String(x.user_id) === String(u.user_id))) _allUsers.push(u);
    }
  }
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
    .filter(u => !_assigneePool || _assigneePool.has(String(u.user_id)))
    .filter(u => !already.has(String(u.user_id)))
    .filter(u => !q || u.username.toLowerCase().includes(q));

  if (!list.length) {
    const emptyText = q ? 'Никого не найдено'
      : (_assigneePool && !_assigneePool.size)
        ? 'В проекте нет постановщиков и ответственных'
        : 'Все уже назначены';
    box.innerHTML = `<p class="text-xs text-slate-400 text-center py-3">${emptyText}</p>`;
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

// Кнопки сложности строятся из COMPLEXITY_META один раз, при первом
// обращении: так подписи живут в одном месте, а не копируются в HTML.
function _ensureComplexityGroup() {
  const group = document.getElementById('card-complexity-group');
  if (!group || group.dataset.built) return group;
  const btn = (value, title, tip) => `
    <label class="cursor-pointer min-w-0" title="${esc(tip)}">
      <input type="radio" name="card-complexity" value="${value}" class="peer hidden">
      <div class="h-full text-center py-1.5 px-1 rounded-lg border border-slate-200 text-[11px] font-medium leading-tight
                  text-slate-600 peer-checked:bg-teal-50 peer-checked:border-teal-400
                  peer-checked:text-teal-800 transition-all">
        <span class="block truncate">${title}</span>
      </div>
    </label>`;
  group.innerHTML = btn('', 'Не оценена', 'Сложность ещё не оценена')
    + Object.entries(COMPLEXITY_META)
        .map(([value, m]) => btn(value, m.label, m.hint)).join('');
  group.dataset.built = '1';
  return group;
}

function _setComplexityRadio(value) {
  _ensureComplexityGroup();
  const target = COMPLEXITY_META[value] ? value : '';
  document.querySelectorAll('input[name="card-complexity"]').forEach(r => {
    r.checked = r.value === target;
  });
}

// null — «не оценена»: сервер принимает его как снятие оценки
function _getComplexityRadio() {
  const checked = document.querySelector('input[name="card-complexity"]:checked');
  return checked && checked.value ? checked.value : null;
}

// Сложность, как и статус, исполнитель меняет без права править задачу:
// в режиме «только комментарии» значение уходит отдельным запросом сразу.
async function onComplexityPicked() {
  const cardId = document.getElementById('card-edit-id').value;
  if (!cardId) return;                  // новая задача — уйдёт вместе с формой

  const card = findCardById(cardId);
  if (!canChangeComplexity(card)) return;
  if (!cardModalCommentOnly) return;    // в полном режиме сохранится по «Сохранить»

  const picked = _getComplexityRadio();
  const result = await api('PATCH', `/cards/${cardId}/complexity`, { complexity: picked });
  if (!result) {
    _setComplexityRadio(card ? card.complexity : null);   // откат
    return;
  }
  if (card) card.complexity = result.complexity;
  toast.success(`Сложность: ${COMPLEXITY_META[result.complexity]?.label || 'не оценена'}`);
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

  // Сложность доступна так же широко, как статус: автору, админу и исполнителям
  _ensureComplexityGroup();
  const complexityAllowed = !ro && opts.canChangeComplexity !== false;
  document.querySelectorAll('input[name="card-complexity"]').forEach(r => {
    r.disabled = !complexityAllowed;
  });
  const complexityGroup = document.getElementById('card-complexity-group');
  if (complexityGroup) complexityGroup.classList.toggle('opacity-50', !complexityAllowed);
  const complexityHint = document.getElementById('card-complexity-hint');
  if (complexityHint) complexityHint.style.display = (complexityAllowed && commentOnly) ? '' : 'none';

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
  if (assignHint) {
    assignHint.style.display = lockedAssignees ? 'none' : '';
    assignHint.textContent = _assigneePool
      ? 'Руководитель назначает исполнителями постановщиков и ответственных проекта.'
      : 'Можно назначить нескольких человек. Каждый увидит задачу у себя на доске.';
  }
  closeAssigneePicker();

  // Загрузка вложений — автору, админу и назначенным исполнителям.
  // Исполнителю остальные поля закрыты, но приложить файл к своей
  // работе он должен уметь. Уже прикреплённые файлы остаются видимыми
  // и скачиваемыми в любом режиме кроме архива.
  cardModalCanEditAttachments =
    !ro && !opts.hideAttachments && opts.canEditAttachments !== false;
  // Без кнопки «Сохранить» файл отправляем сразу, иначе он потеряется.
  cardModalInstantAttachments = cardModalCanEditAttachments && commentOnly;
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) dropZone.style.display = cardModalCanEditAttachments ? '' : 'none';
  const dropHint = document.getElementById('drop-zone-instant-hint');
  if (dropHint) dropHint.style.display = cardModalInstantAttachments ? '' : 'none';

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
