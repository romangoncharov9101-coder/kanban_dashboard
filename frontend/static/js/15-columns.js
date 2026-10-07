'use strict';
// Колонки: перетаскивание и действия.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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
    disabled: !currentUser || !canLeadBoard(),
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
      if (!currentUser || !canLeadBoard() || evt.oldIndex === evt.newIndex) return;
 
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
  if (!canLeadBoard()) return toast.warn('Создавать категории может админ, постановщик или руководитель проекта');
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
  if (!canLeadBoard()) return toast.warn('Недостаточно прав');
  if (!confirm('Удалить категорию? (Она должна быть пустой)')) return;
  await api('DELETE', `/columns/${id}`);
}