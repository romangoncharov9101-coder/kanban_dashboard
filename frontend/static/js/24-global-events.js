'use strict';
// Глобальные обработчики документа.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

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
  if (!outside) return;
  // Карточку задачи закрываем через guard — он спросит про несохранённый
  // комментарий. Остальные диалоги закрываются как раньше, напрямую.
  if (e.target.id === 'modal-card') {
    requestCloseCardModal();
  } else {
    e.target.close();
  }
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
      cardModalCanEditAttachments = false;
      cardModalInstantAttachments = false;
      const instantHint = document.getElementById('drop-zone-instant-hint');
      if (instantHint) instantHint.style.display = 'none';
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
      document.querySelectorAll('input[name="card-complexity"]').forEach(r => { r.disabled = false; });
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
    // Класс на body отключает hover-эффекты доски под окном — см. CSS.
    // Без этого браузер продолжает пересчитывать тени карточек,
    // которых всё равно не видно за подложкой.
    document.body.classList.toggle('modal-open', anyOpen);
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