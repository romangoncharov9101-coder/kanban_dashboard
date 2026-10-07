'use strict';
// Сортировка и фильтрация.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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

    if (currentSortMode === 'complexity') {
      // Тяжёлые сверху, неоценённые (вес 0) — в конце
      const diff = _complexityPoints(b.complexity) - _complexityPoints(a.complexity);
      if (diff !== 0) return diff;
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
  // Назначенное лично ему плюс созданное им самим — как и на сервере
  // (include_own_created). У исполнителя это личные задачи, у руководителя
  // проекта — поставленные им, у постановщика — его задачи.
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
      case 's-paused':
        return card.status === 'PAUSED';
      case 's-review':
        return card.status === 'REVIEW';
      case 's-rework':
        return card.status === 'REWORK';
      case 's-done':
        return card.status === 'DONE';
    }

    // Сложность: c-TRIVIAL … c-EXPERT, c-NONE — «не оценена»
    if (currentFilterMode.startsWith('c-')) {
      const value = COMPLEXITY_META[card.complexity] ? card.complexity : 'NONE';
      return value === currentFilterMode.slice(2);
    }

    return true;
  }
}