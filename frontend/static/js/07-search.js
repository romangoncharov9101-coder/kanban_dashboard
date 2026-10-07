'use strict';
// Глобальный поиск задач и категорий.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// ГЛОБАЛЬНЫЙ ПОИСК ЗАДАЧ/КАТЕГОРИЙ ПО НОМЕРУ ИЛИ НАЗВАНИЮ
// ─────────────────────────────────────────────────────────────────────────────
function onEntitySearchInput(value, suffix = '') {
  clearTimeout(searchDebounce);
  const q = (value || '').trim();
  if (!q) {
    closeEntitySearchResults(suffix);
    return;
  }
  searchDebounce = setTimeout(() => _runEntitySearch(q, suffix), 250);
}

async function _runEntitySearch(query, suffix) {
  if (!currentUser) return;
  const data = await api('GET', `/board/search?query=${encodeURIComponent(query)}`, undefined, true);
  if (!data) return;
  _renderEntitySearchResults(data, suffix);
}

function closeEntitySearchResults(suffix = '') {
  const box = document.getElementById(`entity-search-results${suffix}`);
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

function _renderEntitySearchResults(data, suffix) {
  const box = document.getElementById(`entity-search-results${suffix}`);
  if (!box) return;

  const cardsRes = data.cards || [];
  const colsRes = data.columns || [];

  if (!cardsRes.length && !colsRes.length) {
    box.innerHTML = `<div class="px-3 py-3 text-xs text-slate-400">Ничего не найдено</div>`;
    box.style.display = 'block';
    return;
  }

  window._searchResultsCache = window._searchResultsCache || {};
  cardsRes.forEach(c => window._searchResultsCache[`card:${c.id}`] = c);
  colsRes.forEach(c => window._searchResultsCache[`column:${c.id}`] = c);

  const cardItems = cardsRes.map(c => `
    <button type="button" onclick="goToSearchResultByKey('card:${c.id}')"
      class="w-full text-left px-3 py-2 hover:bg-indigo-50 flex flex-col gap-0.5 border-b border-slate-50">
      <span class="flex items-center gap-1.5 text-xs">
        <span class="font-bold text-indigo-500">T${c.number}</span>
        <span class="font-medium text-slate-700 truncate">${esc(c.title)}</span>
      </span>
      <span class="text-[10px] text-slate-400">📋 задача · ${esc(c.project_name || '')}</span>
    </button>`).join('');

  const colItems = colsRes.map(c => `
    <button type="button" onclick="goToSearchResultByKey('column:${c.id}')"
      class="w-full text-left px-3 py-2 hover:bg-indigo-50 flex flex-col gap-0.5 border-b border-slate-50">
      <span class="flex items-center gap-1.5 text-xs">
        <span class="font-bold text-emerald-500">C${c.number}</span>
        <span class="font-medium text-slate-700 truncate">${esc(c.name)}</span>
      </span>
      <span class="text-[10px] text-slate-400">🗂 категория · ${esc(c.project_name || '')}</span>
    </button>`).join('');

  box.innerHTML = cardItems + colItems;
  box.style.display = 'block';
}

async function goToSearchResultByKey(key) {
  const item = (window._searchResultsCache || {})[key];
  if (!item) return;
  const [type] = key.split(':');
  await goToSearchResult({ type, ...item });
}

async function goToSearchResult(item) {
  closeEntitySearchResults('');
  closeEntitySearchResults('-m');
  ['entity-search-input', 'entity-search-input-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  if (!currentProject || String(currentProject.id) !== String(item.project_id)) {
    await switchProject(item.project_id);
  }

  if (item.type === 'card') {
    focusFilter = { type: 'card', cardId: item.id, columnId: item.column_id, number: item.number };
    renderBoard();
    setTimeout(() => openEditCard(item.id), 50);
  } else {
    focusFilter = { type: 'column', columnId: item.id, number: item.number };
    renderBoard();
  }

  // Мобильный drawer после перехода можно закрыть, чтобы не мешал.
  const drawer = document.getElementById('header-drawer');
  if (drawer) drawer.style.maxHeight = '0px';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#entity-search-box')) closeEntitySearchResults('');
  if (!e.target.closest('#entity-search-box-m')) closeEntitySearchResults('-m');
});

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
          <button onclick="event.stopPropagation(); copyEntityNumber(event, ${col.number}, 'категории', 'C')" title="Скопировать номер категории"
            class="text-[10px] font-bold text-slate-400 hover:text-indigo-600 flex-shrink-0">C${col.number}</button>
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
