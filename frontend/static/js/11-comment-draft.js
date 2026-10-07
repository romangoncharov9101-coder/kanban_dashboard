'use strict';
// Защита неотправленного комментария.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// UNSAVED COMMENT DRAFT GUARD
// ─────────────────────────────────────────────────────────────────────────────
// Если пользователь начал писать комментарий, но не нажал «Отправить»,
// закрытие или сохранение карточки без предупреждения похоронит текст.
// Предупреждаем через собственный <dialog>, а не window.confirm() —
// нативный confirm ненадёжен (может быть заблокирован окружением/браузером
// и не даёт нормально координироваться с событиями <dialog>).
let _commentWarningResolve = null;

function _initCommentWarningModal() {
  const dlg = document.getElementById('modal-comment-warning');
  if (!dlg || dlg.dataset.wired) return;
  dlg.dataset.wired = '1';

  const settle = (result) => {
    const resolve = _commentWarningResolve;
    _commentWarningResolve = null;
    if (resolve) resolve(result);
  };

  const btnCancel = document.getElementById('comment-warning-cancel');
  const btnConfirm = document.getElementById('comment-warning-confirm');
  if (btnCancel) btnCancel.addEventListener('click', () => { dlg.close(); settle(false); });
  if (btnConfirm) btnConfirm.addEventListener('click', () => { dlg.close(); settle(true); });

  // Esc или клик мимо этого окна — тоже считаем отказом (остаться и не терять текст).
  dlg.addEventListener('cancel', () => settle(false));
  dlg.addEventListener('close', () => settle(false));
}

function hasUnsavedCommentDraft() {
  const input = document.getElementById('card-new-comment');
  return !!(input && input.value.trim().length > 0);
}

function showCommentWarningDialog() {
  return new Promise((resolve) => {
    const dlg = document.getElementById('modal-comment-warning');
    if (!dlg) { resolve(true); return; } // на случай отсутствия разметки — не блокируем пользователя
    _initCommentWarningModal();
    _commentWarningResolve = resolve;
    dlg.showModal();
  });
}

async function confirmDiscardCommentDraft() {
  if (!hasUnsavedCommentDraft()) return true;
  return await showCommentWarningDialog();
}

async function requestCloseCardModal() {
  if (!(await confirmDiscardCommentDraft())) return;
  const cardModal = document.getElementById('modal-card');
  if (cardModal && cardModal.open) cardModal.close();
}
