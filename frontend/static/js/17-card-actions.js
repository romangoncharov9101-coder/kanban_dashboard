'use strict';
// Создание, редактирование, удаление задач.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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
  await _loadAssigneePool(_col.project_id || currentProject?.id);
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
    // Руководителю подставляем только тех, кого он вправе назначить.
    selectedAssignees = (currentProject?.members || [])
      .filter(m => !_assigneePool || _assigneePool.has(String(m.user_id)))
      .map(m => ({
        user_id: m.user_id, username: m.username,
      }));
  }
  _renderAssigneeChips();
  _refreshAssigneeSelect();

  const lowPriorityRadio = document.querySelector('input[name="card-priority"][value="LOW"]');
  if (lowPriorityRadio) lowPriorityRadio.checked = true;
  _setComplexityRadio(null);

  const listContainer = document.getElementById('main-comments-section');
  listContainer.classList.add('hidden');

  clearDeadline();
  // Очередь на удаление относится к ранее открытой карточке — в новой
  // задаче ей делать нечего.
  _revokePendingPreviews();
  pendingFiles = [];
  pendingDeletions = [];
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
  // Пул нужен, только если руководитель сам правит состав (он автор)
  if (isFullReadOnly || isCommentOnly) _assigneePool = null;
  else await _loadAssigneePool(card.project_id);
  await _fillAssigneeSelect();
  _renderAssigneeChips();

  document.getElementById('modal-card-title').textContent =
    (isArchived ? '📦 Просмотр (архив)'
    : (isCommentOnly   ? '💬 Задача'
    :                    'Редактирование задачи')) + ` · T${card.number}`;

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
    canChangeComplexity: canChangeComplexity(card),
    canEditAttachments: canEditAttachments(card),
    lockAssignees: ownPersonalCard,
  });

  const commentField = document.getElementById('card-new-comment');
  if (commentField) commentField.value = '';

  const priority = card.priority || "LOW";
  const radioToSelect = document.querySelector(`input[name="card-priority"][value="${priority}"]`);
  if (radioToSelect) radioToSelect.checked = true;
  _setComplexityRadio(card.complexity);

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
  if (!(await confirmDiscardCommentDraft())) return;
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
      toast.warn('Создавать задачи может админ, постановщик или руководитель');
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

    // Мягкое правило: задачу размера XL без описания сохранить можно,
    // но стоит напомнить — исполнителю не от чего будет оттолкнуться.
    const complexity = _getComplexityRadio();
    if (complexity === 'XL' && !desc &&
        !confirm('Задача размера XL без описания. Сохранить всё равно?')) {
      return;
    }

    const payload = {
      title,
      description: desc || null,
      status: _getStatusRadio(),
      complexity,
      deadline,
      priority,
    };

    // Состав исполнителей отправляем только если пользователь вправе его
    // менять. Обычный сотрудник, редактирующий свою задачу, поля не видит,
    // и присылать его не должен — сервер отвечает на это 403.
    if (isManager() || !editId) {
      payload.assignee_ids = assigneeIds;
    }

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
