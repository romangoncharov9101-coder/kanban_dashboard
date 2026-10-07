'use strict';
// Отрисовка карточки на доске.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// RENDER CARD
// ─────────────────────────────────────────────────────────────────────────────
function _deadlineBadge(deadline, status) {
  if (!deadline) return '';

  // Задача на проверке или уже готова — предупреждение о сроке больше
  // не актуально: работа над ней закончена, гнать дедлайном некого.
  const deadlineIrrelevant = status === 'REVIEW' || status === 'DONE';

  const dl = new Date(deadline);
  const now = Date.now();
  const diff = dl - now;
  let cls, label;

  if (deadlineIrrelevant) {
    cls = 'deadline-ok'; label = '';
  } else if (diff < 0) {
    cls = 'deadline-overdue'; label = 'Прострочен';
  } else if (diff < 86400000) {
    cls = 'deadline-soon'; label = 'Скоро';
  } else {
    cls = 'deadline-ok'; label = '';
  }

  const dateStr = dl.toLocaleString([], { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  return `<span class="${cls} text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0">
    ${cls === 'deadline-ok' ? '🕐' : cls === 'deadline-soon' ? '⚡' : '🔴'} ${dateStr}${label ? ' · ' + label : ''}
  </span>`;
}

function _previewImage(card) {
  const images = imageAttachments(card?.attachments);
  if (!images.length) return '';
  const img = images[0];
  // card.id, а не img.id: раньше сюда подставлялся id вложения и путь
  // держался только на том, что сервер игнорирует card_id в URL.
  const src = attachmentUrl(card.id, img.id);
  const rest = images.length - 1;
  return `<div class="card-cover-container">
    <img src="${src}" alt="${esc(img.filename)}"
      class="card-preview-img" loading="lazy"
      onerror="this.closest('.card-cover-container').style.display='none'" />
    ${rest > 0 ? `<span class="card-cover-count">+${rest}</span>` : ''}
  </div>`;
}
 
function _renderCard(c) {
  const creator  = c.created_by_username || '—';
  const assignees = c.assignees || [];
  // Карточка из сводки подпроекта: перетаскивать нельзя (другая доска),
  // но кнопки редактирования подчиняются обычному праву по авторству.
  const foreign = isForeignBoardCard(c);
  const canManage = canManageCard(c);
  const hasAttachments = c.attachments && c.attachments.length > 0;
  const commentsCount = c.comments_count || 0;

  const createdDate = new Date(c.created_at).toLocaleString([], {
    day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
  });

  const deadlineDate = c.deadline
    ? new Date(c.deadline).toLocaleString([], { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
    : null;

  const priorityMap = {
    'HIGHT': { color: 'bg-red-500', text: 'Высокий', bg: 'bg-red-50', textColor: 'text-red-700' },
    'MEDIUM': { color: 'bg-amber-500', text: 'Средний', bg: 'bg-amber-50', textColor: 'text-amber-700' },
    'LOW': { color: 'bg-slate-400', text: 'Низкий', bg: 'bg-slate-50', textColor: 'text-slate-600' }
  };

  const p = priorityMap[c.priority] || priorityMap['LOW'];
  const st = _statusMeta(c.status);
 
  return `
    <div class="card bg-white border border-slate-200 rounded-xl text-sm flex flex-col
                overflow-hidden hover:shadow-md hover:-translate-y-px transition-all duration-150 group relative"
         data-card-id="${c.id}" data-col-id="${c.column_id}"
         ${foreign ? 'data-foreign="1"' : ''}
         onclick="openEditCard('${c.id}')">

      <div class="absolute left-0 top-0 bottom-0 w-1 ${p.color}"></div>

      ${_previewImage(c)}

      <div class="pl-4 pr-3 pt-2.5 pb-2 flex flex-col gap-1.5"> 
        <div class="flex items-start justify-between gap-1">
          <div class="flex flex-col gap-1 flex-1">
            <div class="flex flex-wrap items-center gap-1">
              <button onclick="event.stopPropagation(); copyEntityNumber(event, ${c.number}, 'задачи', 'T')" title="Скопировать номер задачи"
                class="inline-flex items-center gap-0.5 w-fit px-1.5 py-0.5 rounded text-[9px] font-bold
                       bg-slate-100 text-slate-500 hover:bg-indigo-100 hover:text-indigo-600 transition-colors">
                T${c.number} 📋
              </button>
              <span class="inline-block w-fit px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${p.bg} ${p.textColor}">
                ${p.text}
              </span>
              <span class="inline-block w-fit px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${st.cls}">
                ${st.short}
              </span>
              ${_complexityBadge(c.complexity)}
            </div>
            <span class="font-semibold text-slate-800 text-[13px] leading-tight line-clamp-2"
                  title="${esc(c.title)}">${esc(c.title)}</span>
          </div>

          ${canManage ? `
          <div class="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
               onclick="event.stopPropagation()">
               ${c.is_archived ? `
              <button onclick="unarchiveCardAction(event, '${c.id}')" title="Вернуть из архива"
                class="text-amber-500 hover:text-amber-600 p-0.5 rounded">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              </button>
            ` : `
              <button onclick="archiveCardAction(event, '${c.id}')" title="В архив"
                class="text-slate-400 hover:text-amber-500 p-0.5 rounded">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              </button>
            `}
            <button onclick="openEditCard('${c.id}')" title="Редактировать"
              class="text-slate-400 hover:text-indigo-600 p-0.5 rounded">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z"/>
              </svg>
            </button>
            <button onclick="deleteCard('${c.id}')" title="Удалить"
              class="text-slate-400 hover:text-red-500 p-0.5 rounded">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>` : ''}
        </div>

        ${c.description ? `<p class="text-slate-500 text-[11px] line-clamp-2 leading-relaxed">${esc(c.description)}</p>` : ''}

        ${c.deadline ? `<div class="mt-0.5">${_deadlineBadge(c.deadline, c.status)}</div>` : ''}

        <div class="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-100 mt-0.5">
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-[10px] text-slate-400 truncate">✍ ${esc(creator)}</span>
            ${assignees.length ? `<span class="text-[10px] text-indigo-500 font-medium truncate"
                title="${esc(assignees.map(a => a.username).join(', '))}">
                👤 ${esc(assignees[0].username)}${assignees.length > 1 ? ` +${assignees.length - 1}` : ''}
              </span>` : '<span class="text-[10px] text-slate-300 italic">без исполнителя</span>'}
          </div>
          
          <div class="flex items-center gap-1 flex-shrink-0">
            <div class="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-transparent 
                        ${commentsCount > 0 ? 'text-indigo-600 bg-indigo-50 border-indigo-100' : 'text-slate-300'}" 
                 title="Комментарии: ${commentsCount}">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
              <span class="text-[10px] font-bold">${commentsCount}</span>
            </div>

            ${hasAttachments ? `
            <button onclick="event.stopPropagation(); downloadAllAttachmentsFor('${c.id}')" title="Скачать вложения (${c.attachments.length})"
              class="text-[10px] text-slate-500 hover:text-indigo-600 flex items-center gap-0.5 border border-slate-200
                     rounded-full px-1.5 py-0.5 hover:border-indigo-400 transition-colors bg-white">
              <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              ${c.attachments.length}
            </button>` : ''}
          </div>
        </div> 
      </div>
    </div>`;
}

function downloadAllAttachmentsFor(cardId) {
  const card = findCardById(cardId);
  if (!card || !card.attachments || !card.attachments.length) {
    toast.info('Нет вложений для скачивания'); return;
  }
  _downloadAttachments(card.attachments, card.id);
}

function _downloadAttachments(attachments, cardId = null) {
  if (!attachments || !attachments.length) {toast.info('Нет вложений'); return;}
  if (cardId === null) { cardId = document.getElementById('card-edit-id').value; }
  attachments.forEach((a, i) => {
    const attachmentId = a.id;
    setTimeout(() => {
      const link = document.createElement('a');
      link.href = `${API}/cards/${cardId}/attachments/${encodeURIComponent(attachmentId)}/download`;
      link.download = a.filename;
      link.click();
    }, i * 200);
  })
}

async function archiveCardAction(e, cardId) {
  if (e) e.stopPropagation(); 
  if (!canManageCard(findCardById(cardId)))
    return toast.warn('Архивировать может только автор задачи или администратор');
  if (!confirm('Переместить карточку в архив?')) return;

  const res = await api('POST', `/cards/${cardId}/archive`);
  if (res) {
    toast.success('Карточка перемещена в архив');
    
    const card = findCardById(cardId);
    if (card) card.is_archived = true;
    renderBoard(); 
  }
}

async function unarchiveCardAction(e, cardId) {
  if (e) e.stopPropagation();
  if (!canManageCard(findCardById(cardId)))
    return toast.warn('Восстанавливать может только автор задачи или администратор');

  const res = await api('POST', `/cards/${cardId}/unarchive`);
  if (res) {
    toast.success('Карточка восстановлена из архива');
    
    const card = findCardById(cardId);
    if (card) card.is_archived = false;
    renderBoard(); 
  }
}
