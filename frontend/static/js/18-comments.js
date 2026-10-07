'use strict';
// Комментарии и история.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// LEZY COMMENTS LOGIC
// ─────────────────────────────────────────────────────────────────────────────
async function loadMoreComments(cardId) {
  if (isLoadingComments || !commentsHasMore) return;
  isLoadingComments = true;
  const listContainer = document.getElementById('comments-list');

  const oldScrollHeight = listContainer.scrollHeight;
  const oldScrollTop = listContainer.scrollTop;

  try {
    const data = await api('GET', `/cards/${cardId}/comments?last_id=${lastCommentId}`, undefined, true);

    if (data && data.length > 0) {
      if (data.length < COMMENTS_LIMIT) {
        commentsHasMore = false;
      }
      
      const chronological = [...data].reverse();
      _renderCommentsBatch(chronological, true);
      
      lastCommentId = data[data.length - 1].id; 

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          listContainer.scrollTop = oldScrollTop + (listContainer.scrollHeight - oldScrollHeight);
        });
      });
    } else {
      commentsHasMore = false;
    }
  } finally {
    isLoadingComments = false;
  }
}

function _renderCommentsBatch(batch, isPrepend = false) {
  const container = document.getElementById('comments-list');
  if (!container) return;

  const html = batch.map(comment => {
    const date = new Date(comment.created_at).toLocaleString([], {
        day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    });
    const authorName = (comment.author && comment.author.username) 
                           || comment.username 
                           || 'Аноним';

    const authorId = comment.user_id || (comment.author && comment.author.id);
    const isMyComment = currentUser && String(authorId) === String(currentUser.user_id);
    
    return `
      <div class="comment-item bg-white p-3 rounded-lg border border-slate-100 shadow-sm group" data-id="${comment.id}">
        <div class="flex justify-between items-center mb-1">
          <div class="flex items-center gap-2">
            <span class="font-bold text-xs text-indigo-600">${esc(authorName)}</span>
            <span class="text-[10px] text-slate-400">${date}</span>
          </div>
          
          ${isMyComment ? `
          <div id="update-comment" class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onclick="prepareEditComment('${comment.id}')" class="p-1 text-slate-400 hover:text-indigo-600 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
            </button>
            <button onclick="deleteCommentAction('${comment.id}')" class="p-1 text-slate-400 hover:text-red-600 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
          ` : ''}
        </div>
        <div class="comment-content text-sm text-slate-700 whitespace-pre-wrap break-words">${esc(comment.text)}</div>
      </div>
    `;
  }).join('');

  if (isPrepend) {
    container.insertAdjacentHTML('afterbegin', html);
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

async function addCommentAction() {
  const cardId = document.getElementById('card-edit-id').value;
  const input = document.getElementById('card-new-comment');
  const text = input.value.trim();

  if (!cardId || !text) return;

  const res = await api('POST', `/cards/${cardId}/comments`, {text});
  if (res) {
    input.value = '';

    const newCommentForUI = {
        ...res,
        author: res.author || { username: currentUser.username }
    };

    refreshCommentsUI();

    const list = document.getElementById('comments-list');
    list.scrollTo({top: list.scrollHeight, behavior: 'smooth'});
  }
}

async function deleteCommentAction(commentId) {
  if (!confirm('Удалить этот комментарий')) return;

  try {
    const res = await api('DELETE', `/cards/comment/${commentId}`)
    const el = document.querySelector(`.comment-item[data-id="${commentId}"]`);
    if (el) {
      el.remove();
      refreshCommentsUI();
    };
    toast.success('Комментарий удален')
  } catch (err) {
    toast.error('Не удалось удалить комментарий')
  }
}

function prepareEditComment(commentId) {
  const item = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  const contentDiv = item.querySelector('.comment-content');
  const oldText = contentDiv.innerText;

  const btnEd = document.getElementById('update-comment')
  btnEd.classList.add('hidden')

  contentDiv.innerHTML = `
    <textarea class="edit-comment-area w-full p-2 border border-indigo-300 rounded-md text-sm focus:outline-none resize-none no-scrollbar">${esc(oldText)}</textarea>
    <div class="flex justify-end gap-2 mt-2">
      <button onclick="cancelEditComment('${commentId}', \`${esc(oldText)}\`)" class="text-[10px] text-slate-500 hover:underline">Отмена</button>
      <button onclick="saveEditComment('${commentId}')" class="text-[10px] text-indigo-600 font-bold hover:underline">Сохранить</button>
    </div>
  `;
  
  const textarea = contentDiv.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function cancelEditComment(commentId, oldText) {
  const item = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  item.querySelector('.comment-content').innerText = oldText;

  const btnEd = document.getElementById('update-comment')
  btnEd.classList.remove('hidden')
}

async function saveEditComment(commentId) {
  const item = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  const textarea = item.querySelector('.edit-comment-area');
  const newText = textarea.value.trim();

  const btnEd = document.getElementById('update-comment')
  btnEd.classList.add('hidden')

  if (!newText) return;

  try {
    const res = await api('PATCH', `/cards/comments/${commentId}`, { text: newText });
    
    if (res) {
      item.querySelector('.comment-content').innerText = res.text;
      toast.success('Изменено');
    }
  } catch (err) {
    toast.error('Ошибка при сохранении');
  }
}

function toggleEmojiPicker() {
  let picker = document.getElementById('emoji-picker');
  
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'emoji-picker';
    picker.className = 'absolute bottom-full right-0 mb-2 bg-white border border-slate-200 shadow-xl rounded-lg p-2 grid grid-cols-6 gap-1 z-50';
    
    const emojis = ['👍', '❤️', '🔥', '✅', '🚀', '⭐', '👀', '🙌', '💡', '🤔', '❌', '💯'];
    
    picker.innerHTML = emojis.map(e => `
      <button type="button" onclick="insertEmoji('${e}')" 
              class="hover:bg-slate-100 p-1.5 rounded text-lg transition-colors">
        ${e}
      </button>
    `).join('');
  
    const btn = event.currentTarget;
    btn.parentElement.classList.add('relative');
    btn.parentElement.appendChild(picker);
  } else {
    picker.classList.toggle('hidden');
  }

  const closePicker = (e) => {
    if (!picker.contains(e.target) && e.target !== document.querySelector('[onclick="toggleEmojiPicker()"]')) {
      picker.classList.add('hidden');
      document.removeEventListener('click', closePicker);
    }
  };
  
  if (!picker.classList.contains('hidden')) {
    setTimeout(() => document.addEventListener('click', closePicker), 10);
  }
}

function insertEmoji(emoji) {
  const input = document.getElementById('card-new-comment');
  if (input) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = input.value;
    input.value = text.substring(0, start) + emoji + text.substring(end);
    
    input.focus();
    input.setSelectionRange(start + emoji.length, start + emoji.length);
  }
  
  document.getElementById('emoji-picker')?.classList.add('hidden');
}
