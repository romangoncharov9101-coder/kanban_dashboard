'use strict';
// Инициализация приложения.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Значение дедлайна ставит календарь, отдельный слушатель не нужен

  _initLightbox();

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

      // Сохранённое значение могло устареть (например, старые уровни
      // сложности c-TRIVIAL…). Такого пункта в списке нет — сбрасываем,
      // иначе доска окажется пустой без видимой причины.
      const hasOption = (id, v) =>
        !!document.querySelector(`#${id} option[value="${CSS.escape(v)}"]`);
      if (!hasOption('filter-select', currentFilterMode)) currentFilterMode = 'all';
      if (!hasOption('sort-select', currentSortMode)) currentSortMode = 'position';
      
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
