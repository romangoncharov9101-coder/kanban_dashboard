'use strict';
// Вложения и загрузка файлов.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// MODAL: ATTACHMENTS (in edit mode)
// ─────────────────────────────────────────────────────────────────────────────
function _renderAttachmentsList(attachments) {
  const list = document.getElementById('attachments-list');
  const dlBtn = document.getElementById('btn-download-all');

  // Галерея — отдельным блоком над списком: картинки удобнее смотреть,
  // а не опознавать по имени файла.
  _renderAttachmentsGallery(attachments);

  if (!list) return;
  if (!attachments || !attachments.length) {
    list.innerHTML = '<p class="text-xs text-slate-400 italic">Нет вложений</p>';
    if (dlBtn) dlBtn.disabled = true;
    return;
  }

  if (dlBtn) dlBtn.disabled = false;

  list.innerHTML = '';
  attachments.forEach(a =>{
    const isImage = a.content_type && a.content_type.startsWith('image/');
    const iconEl  = isImage ? '🖼' : '📄';
    const item    = document.createElement('div');
    item.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs';
 
    const iconSpan = document.createElement('span');
    iconSpan.textContent = iconEl;
 
    const nameEl = document.createElement('span');
    nameEl.className = 'flex-1 truncate text-slate-700';
    nameEl.textContent = a.filename;

    if (isImage) {
      const idx = _lightboxIndexOf(a.id);
      if (idx >= 0) {
        nameEl.className += ' cursor-pointer hover:text-indigo-600 hover:underline';
        nameEl.title = 'Открыть изображение';
        nameEl.onclick = () => openLightbox(idx);
        iconSpan.className = 'cursor-pointer';
        iconSpan.onclick = () => openLightbox(idx);
      }
    }
 
    item.appendChild(iconSpan);
    item.appendChild(nameEl);

    if (a.isPending) {
      // Файл ещё не на сервере: скачивать нечего, ссылка вела бы в 404.
      item.className = 'flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs';
      const badge = document.createElement('span');
      badge.className = 'text-amber-600 text-[10px] flex-shrink-0';
      badge.textContent = 'ожидает';
      item.appendChild(badge);
    } else {
      const dlLink = document.createElement('a');
      const cardId = document.getElementById('card-edit-id').value;
      dlLink.href = `${API}/cards/${cardId}/attachments/${encodeURIComponent(a.id)}/download`;
      dlLink.download = a.filename;
      dlLink.className = 'text-indigo-500 hover:text-indigo-700 flex-shrink-0';
      dlLink.title = 'Скачать';
      dlLink.textContent = '⬇';
      item.appendChild(dlLink);
    }

    // Удалять вложение может тот же круг, что и прикреплять:
    // админ, автор задачи и её исполнители.
    // Скачать — любой, кто видит карточку.
    if (cardModalCanEditAttachments) {
      const delBtn = document.createElement('button');
      delBtn.className = 'text-red-400 hover:text-red-600 flex-shrink-0';
      delBtn.title = 'Удалить';
      delBtn.textContent = '✕';
      delBtn.onclick = () => deleteAttachment(a.id, a.isPending);
      item.appendChild(delBtn);
    }
    list.appendChild(item);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАГРУЗКА ФАЙЛОВ
// ─────────────────────────────────────────────────────────────────────────────
function handleFileDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('drop-zone');
  zone.classList.remove('border-indigo-500', 'bg-indigo-50');
  const files = Array.from(event.dataTransfer.files);
  _processFiles(files);
}

function handleFileInputChange(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  _processFiles(files);
}

async function _processFiles(files) {
  // Лимиты держим ровно те же, что и на сервере (5 МБ, 5 файлов на карточку):
  // иначе пользователь узнаёт об отказе только после загрузки.
  const MAX_SIZE = 5 * 1024 * 1024;
  const MAX_FILES = 5;
  const ALLOWED  = ['image/', 'application/pdf', 'application/msword',
                    'application/vnd.openxmlformats', 'application/vnd.ms-excel',
                    'text/plain', 'application/zip'];

  const cardId = document.getElementById('card-edit-id').value;

  if (!cardModalCanEditAttachments) {
    return toast.warn('Прикреплять файлы к этой задаче вам нельзя');
  }

  const card = cardId ? findCardById(cardId) : null;
  const already = (card?.attachments || []).filter(a => !pendingDeletions.includes(a.id)).length;

  const accepted = [];
  for (const file of files) {
    if (file.size > MAX_SIZE) {
      toast.warn(`«${file.name}» слишком большой (макс. 5 МБ)`); continue;
    }
    const allowed = ALLOWED.some(t => file.type.startsWith(t));
    if (!allowed) {
      toast.warn(`«${file.name}» — неподдерживаемый тип файла`); continue;
    }
    if (already + pendingFiles.length + accepted.length >= MAX_FILES) {
      toast.warn(`Больше ${MAX_FILES} файлов на задачу прикрепить нельзя`); break;
    }
    accepted.push(file);
  }

  if (!accepted.length) return;

  if (cardModalInstantAttachments && cardId) {
    // Исполнителю сохранять нечего — форма ему закрыта. Отправляем файл
    // на сервер сразу, чтобы он не пропал при закрытии окна.
    for (const file of accepted) {
      await _uploadFileTo(cardId, file);
    }
    _refreshAttachmentsUI();
    return;
  }

  accepted.forEach(_addToPending);
  _refreshAttachmentsUI();
}

function _refreshAttachmentsUI() {
  const cardId = document.getElementById('card-edit-id').value;
  const card = findCardById(cardId);
  
  const existing = (card?.attachments || []).filter(a => !pendingDeletions.includes(a.id));
  
  // id ожидающих файлов — их имя: именно по нему deleteAttachment
  // убирает файл из очереди. Индекс сюда не годится, он «уезжает»
  // после удаления любого элемента из середины списка.
  const pending = pendingFiles.map(f => ({
    id: f.name,
    filename: f.name,
    isPending: true,
    content_type: f.type,
    _file: f
  }));

  _renderAttachmentsList([...existing, ...pending]);
}

function _addToPending(file) {
  if (pendingFiles.find(f => f.name === file.name && f.size === file.size)) {
    toast.info(`«${file.name}» уже в списке`); return;
  }
  pendingFiles.push(file);
  _renderPendingList();
}

function _renderPendingList() {
  const list  = document.getElementById('attachments-list');
  const dlBtn = document.getElementById('btn-download-all');

  // Галерею перерисовываем всегда, даже если очередь пуста: иначе в окне
  // новой задачи оставались миниатюры от предыдущей открытой карточки.
  _renderAttachmentsGallery(pendingFiles.map(f => ({
    id: f.name,
    filename: f.name,
    isPending: true,
    content_type: f.type,
    _file: f
  })));

  if (!list) return;

  if (!pendingFiles.length) {
    list.innerHTML = '<p class="text-xs text-slate-400 italic">Нет файлов</p>';
    if (dlBtn) dlBtn.disabled = true;
    return;
  }

  if (dlBtn) dlBtn.disabled = true;

  list.innerHTML = '';
  pendingFiles.forEach((file, idx) => {
    const isImage = file.type.startsWith('image/');
    const item = document.createElement('div');
    item.className = 'flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs';

    const icon = document.createElement('span');
    icon.textContent = isImage ? '🖼' : '📄';

    const name = document.createElement('span');
    name.className = 'flex-1 truncate text-slate-700';
    name.textContent = file.name;

    const badge = document.createElement('span');
    badge.className = 'text-amber-600 text-[10px] flex-shrink-0';
    badge.textContent = 'ожидает';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'text-red-400 hover:text-red-600 flex-shrink-0';
    removeBtn.title = 'Убрать';
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => {
      pendingFiles.splice(idx, 1);
      // Перерисовываем весь блок, а не только очередь: иначе из списка
      // пропадали бы уже прикреплённые файлы и галерея.
      _refreshAttachmentsUI();
    };

    item.appendChild(icon); item.appendChild(name);
    item.appendChild(badge); item.appendChild(removeBtn);
    list.appendChild(item);
  });
}

async function _uploadFileTo(cardId, file) {
  const fd = new FormData();
  fd.append('file', file);
  const result = await apiUpload(`/cards/${cardId}/attachments`, fd);
  if (result) {
    toast.success(`«${file.name}» прикреплён`);
    const card = findCardById(cardId);
    if (card) {
      if (!card.attachments) card.attachments = [];
      card.attachments.push(result);
      // Через _refreshAttachmentsUI, а не напрямую: иначе из списка
      // пропадут файлы, ещё стоящие в очереди на отправку.
      _refreshAttachmentsUI();
      renderBoard();
    }
  }
}

async function _flushPendingFiles(cardId) {
  if (!pendingFiles.length) return;
  const files = [...pendingFiles];
  pendingFiles = [];
  for (const file of files) {
    await _uploadFileTo(cardId, file);
  }
}

async function uploadAttachment() {
  const cardId = document.getElementById('card-edit-id').value;
  const fileInput = document.getElementById('attachment-file-input');
  if (!fileInput.files.length) return;
  await _processFiles(Array.from(fileInput.files));
  fileInput.value = '';
}

async function deleteAttachment(attachmentId, isPending = false) {
  if (!cardModalCanEditAttachments) {
    return toast.warn('Удалять вложения этой задачи вам нельзя');
  }

  if (isPending) {
    pendingFiles = pendingFiles.filter(f => f.name !== attachmentId);
    _refreshAttachmentsUI();
    return;
  }

  const cardId = document.getElementById('card-edit-id').value;

  if (cardModalInstantAttachments) {
    // Кнопки «Сохранить» в этом режиме нет, поэтому отложенное удаление
    // никогда бы не применилось. Спрашиваем подтверждение и удаляем сразу.
    if (!confirm('Удалить вложение? Действие необратимо.')) return;
    // Напрямую через fetch, а не через api(): тот возвращает null и на
    // успешный 204, и на ошибку, а здесь эти случаи надо различать.
    let res;
    try {
      res = await fetch(`${API}/cards/attachments/${attachmentId}`,
                        { method: 'DELETE', credentials: 'include' });
    } catch (e) {
      return toast.error('Не удалось связаться с сервером');
    }
    if (!res.ok) {
      let detail = `Ошибка ${res.status}`;
      try { detail = (await res.json())?.detail || detail; } catch (e) {}
      return toast.error(typeof detail === 'string' ? detail : 'Не удалось удалить вложение');
    }
    const card = findCardById(cardId);
    if (card) {
      card.attachments = (card.attachments || []).filter(a => String(a.id) !== String(attachmentId));
    }
    _refreshAttachmentsUI();
    renderBoard();
    toast.success('Вложение удалено');
    return;
  }

  if (!pendingDeletions.includes(attachmentId)) {
    pendingDeletions.push(attachmentId);
  }
  _refreshAttachmentsUI();
  toast.success('Вложение помечено на удаление. Нажмите «Сохранить».');
}

function downloadAllAttachments() {
  const cardId = document.getElementById('card-edit-id').value;
  const card = findCardById(cardId);
  if (!card) return;
  _downloadAttachments(card.attachments);
}
