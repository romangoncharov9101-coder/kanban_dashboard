'use strict';
// Глобальное состояние, справочники статусов и сложности.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

const API = window.location.origin + '/api';

const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let currentUser = null;
let ws = null, wsTimer = null;
let columns = [], cards = [], onlineUsers = [];
let boardSortable = null;
let searchTimeout = null;
let selectedAssignees = [];   // [{user_id, username}] в открытой модалке карточки
let projects = [];            // дерево проектов, доступное текущему пользователю
let currentProject = null;    // {id, name, parent_id, is_root, can_manage}
let subSections = [];         // сводка подпроектов на корневом проекте
let selectedOwners = [];      // постановщики в модалке проекта
let selectedMembers = [];     // ответственные исполнители в модалке проекта
let selectedManagers = [];    // руководители в модалке проекта
let _assigneesLocked = false; // состав исполнителей нельзя менять (личная задача)
const GLOBAL_BOARD_ID = '__all__';  // псевдо-проект «Все проекты» (только админ)
const JOURNAL_ID = '__journal__';   // вкладка «Журнал действий» (только админ)

let journalOffset = 0;
let journalTotal = 0;
const JOURNAL_LIMIT = 50;
let journalSearchTimer = null;

let globalUserFilter = '';   // user_id: показывать только его задачи (вкладка «Все проекты»)

// Стадия работы над задачей. Отличается от категории: колонки свои
// в каждом проекте, а статус общий для всей системы.
const STATUS_META = {
  NOT_STARTED: { label: 'Не начата', short: 'Не начата', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  IN_PROGRESS: { label: 'В работе',  short: 'В работе',  cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  PAUSED:      { label: 'Пауза',     short: 'Пауза',     cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  REVIEW:      { label: 'Проверка',  short: 'Проверка',  cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  REWORK:      { label: 'Доработка', short: 'Доработка', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  DONE:        { label: 'Готово',    short: 'Готово',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

function _statusMeta(value) {
  return STATUS_META[value] || STATUS_META.NOT_STARTED;
}

// Сложность (трудоёмкость) задачи. Единственный источник подписей и
// весов на фронте: из него строятся точки на карточке, кнопки в модалке
// и сумма очков в шапке колонки. Пустое значение (null) = «не оценена».
// pts — только порядок для сортировки «По сложности», на экран не выводится.
// hint — подсказка при наведении на кнопку в модалке и на бейдж карточки.
// cls — бейдж на карточке: один оттенок, насыщеннее с ростом размера,
// чтобы не спорить по цвету с приоритетом и статусом.
const COMPLEXITY_META = {
  S:  { label: 'S',  pts: 1, hint: 'Небольшая правка, до нескольких часов',
        cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  M:  { label: 'M',  pts: 2, hint: 'Стандартная задача на 1–2 дня',
        cls: 'bg-teal-100 text-teal-800 border-teal-300' },
  L:  { label: 'L',  pts: 3, hint: 'Сложная задача на 3–5 дней',
        cls: 'bg-teal-600 text-white border-teal-600' },
  XL: { label: 'XL', pts: 4, hint: 'Отдельный этап проекта, требует декомпозиции',
        cls: 'bg-teal-800 text-white border-teal-800' },
};

function _complexityPoints(value) {
  return COMPLEXITY_META[value]?.pts || 0;
}

// Бейдж сложности на карточке — в том же стиле, что приоритет и статус.
// Значок 🧩 отличает его от приоритета («Средний» / «Средняя»).
// У неоценённой задачи бейджа нет, чтобы не шуметь на доске.
function _complexityBadge(value) {
  const m = COMPLEXITY_META[value];
  if (!m) return '';
  return `<span class="inline-flex items-center gap-0.5 w-fit px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${m.cls}"
               title="Сложность ${m.label}: ${m.hint}">🧩 ${m.label}</span>`;
}

// Статус двигает тот, кто над задачей работает: админ, автор задачи
// (постановщик или руководитель) и любой её исполнитель.
// Это шире, чем право править саму задачу.
function canChangeStatus(card) {
  if (!currentUser || !card) return false;
  if (isAdmin()) return true;
  const meId = String(currentUser.user_id);
  if ((card.assignees || []).some(a => String(a.user_id) === meId)) return true;
  return (currentUser.role === 'TEAM_LEAD' || currentUser.role === 'PROJECT_MANAGER')
    && String(card.created_by) === meId;
}

// Сложность меняют те же, кто двигает статус: админ, автор-постановщик
// и любой исполнитель задачи — он лучше всех знает реальную трудоёмкость.
function canChangeComplexity(card) {
  return canChangeStatus(card);
}

function isJournalView() {
  return !!currentProject && String(currentProject.id) === JOURNAL_ID;
}

function isGlobalBoard() {
  return !!currentProject && String(currentProject.id) === GLOBAL_BOARD_ID;
}
let cardModalReadOnly = false;  // полный запрет редактирования (архив, чужой проект)
let cardModalCommentOnly = false; // только комментарии: назначен исполнителем, но не автор
// Можно ли в текущем окне трогать вложения. Считается отдельно от
// остальных прав: исполнитель чужой задачи файлы прикладывать может.
let cardModalCanEditAttachments = false;
// В режиме «только комментарии» кнопки «Сохранить» нет, поэтому копить
// файлы в pendingFiles бессмысленно — их некому будет отправить.
// Такие вложения уходят на сервер сразу при выборе.
let cardModalInstantAttachments = false;
let pendingFiles = [];
let pendingDeletions = [];
let currentSortMode = 'position';
let currentFilterMode = 'all';
// Режим «фокуса»: после перехода из глобального поиска показываем
// только найденную задачу/категорию, остальное скрыто до сброса.
let focusFilter = null; // {type:'card', cardId, columnId} | {type:'column', columnId}
let searchDebounce = null;
let lastSpacePress = 0;
let lastAPress = 0;
let lastCommentId = null;
let commentsHasMore = true;
let isLoadingComments = false;
let lastEventId = null;
let historyHasMore = true;
let isLoadingHistory = false;
let isDragging = false;
const remoteDrags = new Map();
const cardSortables = new Map();
const DOUBLE_PRESS_DELAY = 300;
const COMMENTS_LIMIT = 20;
const EVENTS_LIMIT = 20;
