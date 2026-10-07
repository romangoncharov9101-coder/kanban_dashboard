'use strict';
// Проекты: меню, переключение, сводка подпроектов.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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
  focusFilter = null;
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
    const allowed = currentUser && canManageProject;
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