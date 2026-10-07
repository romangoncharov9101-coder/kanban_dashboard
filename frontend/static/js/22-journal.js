'use strict';
// Журнал действий.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// ЖУРНАЛ ДЕЙСТВИЙ (только ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_META = {
  CARD_CREATED:       { icon: '➕', label: 'Задача создана',        cls: 'bg-emerald-50 text-emerald-700' },
  CARD_EDITED:        { icon: '✏️', label: 'Задача изменена',       cls: 'bg-blue-50 text-blue-700' },
  CARD_MOVED:         { icon: '↔️', label: 'Задача перемещена',     cls: 'bg-sky-50 text-sky-700' },
  CARD_ASSIGNED:      { icon: '👥', label: 'Исполнители',           cls: 'bg-indigo-50 text-indigo-700' },
  CARD_ARCHIVED:      { icon: '📦', label: 'В архив',               cls: 'bg-amber-50 text-amber-700' },
  CARD_RESTORED:      { icon: '♻️', label: 'Из архива',             cls: 'bg-amber-50 text-amber-700' },
  CARD_DELETED:       { icon: '🗑', label: 'Задача удалена',        cls: 'bg-red-50 text-red-600' },
  COMMENT_ADDED:      { icon: '💬', label: 'Комментарий',           cls: 'bg-slate-100 text-slate-600' },
  COMMENT_EDITED:     { icon: '💬', label: 'Комментарий изменён',   cls: 'bg-slate-100 text-slate-600' },
  COMMENT_DELETED:    { icon: '💬', label: 'Комментарий удалён',    cls: 'bg-red-50 text-red-600' },
  ATTACHMENT_ADDED:   { icon: '📎', label: 'Файл добавлен',         cls: 'bg-slate-100 text-slate-600' },
  ATTACHMENT_DELETED: { icon: '📎', label: 'Файл удалён',           cls: 'bg-red-50 text-red-600' },
  COLUMN_CREATED:     { icon: '🗂', label: 'Категория создана',     cls: 'bg-emerald-50 text-emerald-700' },
  COLUMN_UPDATED:     { icon: '🗂', label: 'Категория изменена',    cls: 'bg-blue-50 text-blue-700' },
  COLUMN_DELETED:     { icon: '🗂', label: 'Категория удалена',     cls: 'bg-red-50 text-red-600' },
  PROJECT_CREATED:    { icon: '📁', label: 'Проект создан',         cls: 'bg-emerald-50 text-emerald-700' },
  PROJECT_UPDATED:    { icon: '📁', label: 'Проект изменён',        cls: 'bg-blue-50 text-blue-700' },
  PROJECT_DELETED:    { icon: '📁', label: 'Проект удалён',         cls: 'bg-red-50 text-red-600' },
  USER_CREATED:       { icon: '👤', label: 'Пользователь создан',   cls: 'bg-emerald-50 text-emerald-700' },
  USER_UPDATED:       { icon: '👤', label: 'Пользователь изменён',  cls: 'bg-blue-50 text-blue-700' },
  USER_DEACTIVATED:   { icon: '🚫', label: 'Доступ отключён',       cls: 'bg-red-50 text-red-600' },
  USER_LOGIN:         { icon: '🔑', label: 'Вход',                  cls: 'bg-slate-100 text-slate-500' },
  USER_LOGOUT:        { icon: '🚪', label: 'Выход',                 cls: 'bg-slate-100 text-slate-500' },
};

function _journalMeta(type) {
  return EVENT_META[type] || { icon: '•', label: type, cls: 'bg-slate-100 text-slate-600' };
}

async function openJournal() {
  if (!isAdmin()) return toast.warn('Журнал действий доступен только администратору');
  currentProject = { id: JOURNAL_ID, name: 'Журнал действий', is_root: false, can_manage: false };
  journalOffset = 0;
  closeProjectDrawer();
  sessionStorage.setItem('last_project_id', JOURNAL_ID);
  _applyJournalLayout();
  _renderProjectTree();
  await _fillJournalUsers();
  await loadJournal();
}

// Журнал занимает то же место, что и доска: прячем всё лишнее,
// иначе под таблицей событий останутся колонки прошлого проекта.
function _applyJournalLayout() {
  const on = isJournalView();
  const board = document.getElementById('board');
  const sections = document.getElementById('subproject-sections');
  const filterBar = document.getElementById('global-filter-bar');
  const journal = document.getElementById('journal-view');

  if (board) board.style.display = on ? 'none' : '';
  if (sections) sections.style.display = on ? 'none' : '';
  if (on && filterBar) filterBar.style.display = 'none';
  if (journal) journal.style.display = on ? '' : 'none';

  const title = document.getElementById('board-title');
  const crumb = document.getElementById('board-breadcrumb');
  if (on) {
    if (title) title.textContent = 'Журнал действий';
    if (crumb) crumb.textContent = 'вся история изменений в системе';
  }

  // Список онлайна и кнопка колонки к журналу отношения не имеют
  const onlineBar = document.getElementById('online-bar');
  if (onlineBar) onlineBar.style.display = on ? 'none' : '';

  const addColBtn = document.getElementById('btn-add-col');
  if (on && addColBtn) addColBtn.style.display = 'none';
}

async function _fillJournalUsers() {
  const sel = document.getElementById('journal-user');
  if (!sel) return;
  if (!_allUsers.length) {
    const users = await api('GET', '/users', undefined, true);
    _allUsers = (users || []).filter(u => u.is_active);
  }
  const current = sel.value;
  sel.innerHTML = '<option value="">Все пользователи</option>' +
    _allUsers.map(u => `<option value="${u.user_id}">${esc(u.username)}</option>`).join('');
  sel.value = current;
}

function _journalQuery() {
  const p = new URLSearchParams();
  p.set('limit', JOURNAL_LIMIT);
  p.set('offset', journalOffset);

  const q = document.getElementById('journal-search')?.value.trim();
  const cat = document.getElementById('journal-category')?.value;
  const user = document.getElementById('journal-user')?.value;
  const from = document.getElementById('journal-from')?.value;
  const to = document.getElementById('journal-to')?.value;

  if (q) p.set('q', q);
  if (cat) p.set('category', cat);
  if (user) p.set('user_id', user);
  if (from) p.set('date_from', `${from}T00:00:00`);
  // Верхняя граница включительно: конец выбранного дня
  if (to) p.set('date_to', `${to}T23:59:59`);
  return p.toString();
}

async function loadJournal() {
  const list = document.getElementById('journal-list');
  if (!list) return;
  list.innerHTML = '<p class="text-center text-slate-400 text-sm py-8">Загрузка…</p>';

  const data = await api('GET', `/events/journal?${_journalQuery()}`);
  if (!data) {
    list.innerHTML = '<p class="text-center text-red-400 text-sm py-8">Не удалось загрузить журнал</p>';
    return;
  }

  journalTotal = data.total;
  _renderJournal(data.items);
  _renderJournalPager();
}

function _renderJournal(items) {
  const list = document.getElementById('journal-list');
  if (!list) return;

  const totalEl = document.getElementById('journal-total');
  if (totalEl) totalEl.textContent = journalTotal
    ? `${journalTotal} ${_plural(journalTotal, 'запись', 'записи', 'записей')}`
    : '';

  if (!items.length) {
    list.innerHTML = '<p class="text-center text-slate-400 text-sm py-8">Ничего не найдено</p>';
    return;
  }

  let lastDay = null;
  const rows = [];

  items.forEach(e => {
    const d = new Date(e.created_at);
    const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    if (day !== lastDay) {
      lastDay = day;
      rows.push(`<div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide pt-3 pb-1">${esc(day)}</div>`);
    }

    const meta = _journalMeta(e.event_type);
    const who = e.actor_username || 'система';
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    const tags = [];
    if (e.project_name) tags.push(`<span class="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">📁 ${esc(e.project_name)}</span>`);
    if (e.column_name) tags.push(`<span class="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">🗂 ${esc(e.column_name)}</span>`);
    if (e.target_username) tags.push(`<span class="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">👤 ${esc(e.target_username)}</span>`);

    rows.push(`
      <div class="flex items-start gap-3 bg-white border border-slate-200 rounded-xl px-3 py-2.5">
        <span class="text-base leading-none pt-0.5 flex-shrink-0">${meta.icon}</span>

        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-2 mb-0.5">
            <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${meta.cls}">${esc(meta.label)}</span>
            <span class="inline-flex items-center gap-1.5">
              <span class="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold
                           ${_avatarColor(who)}">${esc(_initials(who))}</span>
              <span class="text-xs font-medium text-slate-600">${esc(who)}</span>
            </span>
            <span class="text-[11px] text-slate-400">${time}</span>
          </div>
          <p class="text-sm text-slate-700 break-words">${esc(e.message)}</p>
          ${tags.length ? `<div class="flex flex-wrap gap-1 mt-1.5">${tags.join('')}</div>` : ''}
        </div>
      </div>`);
  });

  list.innerHTML = rows.join('');
}

function _renderJournalPager() {
  const prev = document.getElementById('journal-prev');
  const next = document.getElementById('journal-next');
  const info = document.getElementById('journal-page');

  const page = Math.floor(journalOffset / JOURNAL_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(journalTotal / JOURNAL_LIMIT));

  if (prev) prev.disabled = journalOffset === 0;
  if (next) next.disabled = journalOffset + JOURNAL_LIMIT >= journalTotal;
  if (info) info.textContent = `${page} из ${pages}`;
}

async function journalPage(direction) {
  const next = journalOffset + direction * JOURNAL_LIMIT;
  if (next < 0 || next >= journalTotal) return;
  journalOffset = next;
  await loadJournal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function applyJournalFilters() {
  journalOffset = 0;
  await loadJournal();
}

async function resetJournalFilters() {
  ['journal-search', 'journal-from', 'journal-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['journal-category', 'journal-user'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  await applyJournalFilters();
}
