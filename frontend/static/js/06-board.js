'use strict';
// Загрузка и отрисовка доски.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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
    const allowed = currentUser && !isArchived && !!currentProject?.can_manage;
    btnAddCol.style.display = allowed ? '' : 'none';
  }

  const sorter = getCardSorted();
  const filter = getCardFilter();
  let sortedCols = [...columns].sort((a, b) => a.position - b.position);

  if (focusFilter) {
    sortedCols = sortedCols.filter(c => String(c.id) === String(focusFilter.columnId));
  }

  sortedCols.forEach(col => {
        let colCards = cards
            .filter(c => c.column_id === col.id)
            .filter(filter)
            .sort(sorter);

        if (focusFilter && focusFilter.type === 'card') {
          colCards = colCards.filter(c => String(c.id) === String(focusFilter.cardId));
        }

        board.insertAdjacentHTML('beforeend', _renderColumn(col, colCards));
    });

  _renderFocusBanner();


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
 
function _renderFocusBanner() {
  let el = document.getElementById('focus-banner');
  if (!focusFilter) {
    if (el) el.remove();
    return;
  }
  const label = focusFilter.type === 'card'
    ? `Показана только задача T${focusFilter.number}`
    : `Показана только категория C${focusFilter.number}`;

  if (!el) {
    el = document.createElement('div');
    el.id = 'focus-banner';
    el.className = 'w-full flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-lg ' +
      'bg-indigo-50 border border-indigo-200 text-indigo-700 text-sm';
    const board = document.getElementById('board');
    board.parentNode.insertBefore(el, board);
  }
  el.innerHTML = `
    <span>🔎 ${esc(label)}</span>
    <button onclick="clearFocus()" class="text-xs font-semibold px-2 py-1 rounded-lg bg-white border border-indigo-200 hover:bg-indigo-100">
      Показать всё
    </button>`;
}

function clearFocus() {
  focusFilter = null;
  renderBoard();
}