'use strict';
// Дедлайны и календарь выбора даты.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// DEADLINE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _toDatetimeLocal(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d - offset).toISOString().slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEADLINE PICKER — календарь с быстрым выбором вместо datetime-local.
// Системный datetime-local нельзя стилизовать и в нём нет пресетов.
// ─────────────────────────────────────────────────────────────────────────────
let _dlValue = null;   // выбранная дата (Date) или null
let _dlMonth = null;   // месяц, показанный в календаре

const _MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                 'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

// Быстрый выбор: смещение от «сейчас» в днях и время по умолчанию
const DEADLINE_SHORTCUTS = [
  { text: 'Сегодня',      days: 0,  hour: 18 },
  { text: 'Завтра',       days: 1,  hour: 12 },
  { text: 'Через 3 дня',  days: 3,  hour: 12 },
  { text: 'Через неделю', days: 7,  hour: 12 },
  { text: 'Через месяц',  days: 30, hour: 12 },
];

function _dlShortcutDate(sc) {
  const d = new Date();
  d.setDate(d.getDate() + sc.days);
  d.setHours(sc.hour, 0, 0, 0);
  return d;
}

function _dlFormat(d) {
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function _dlSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function toggleDeadlinePicker(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('deadline-panel');
  if (!panel) return;
  panel.style.display !== 'none' ? closeDeadlinePicker() : openDeadlinePicker();
}

function openDeadlinePicker() {
  const trigger = document.getElementById('deadline-trigger');
  if (trigger && trigger.disabled) return;      // режим просмотра

  const panel = document.getElementById('deadline-panel');
  if (!panel) return;

  _dlMonth = new Date(_dlValue || new Date());
  _dlMonth.setDate(1);
  panel.style.display = '';
  _renderDeadlineShortcuts();
  _renderDeadlineCalendar();

  const time = document.getElementById('deadline-time');
  if (time) {
    const d = _dlValue || new Date();
    time.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

function closeDeadlinePicker() {
  const panel = document.getElementById('deadline-panel');
  if (panel) panel.style.display = 'none';
}

function _renderDeadlineShortcuts() {
  const box = document.getElementById('deadline-shortcuts');
  if (!box) return;
  box.innerHTML = DEADLINE_SHORTCUTS.map((sc, i) => `
    <button type="button" onclick="pickDeadlineShortcut(${i})"
      class="text-left text-xs text-slate-600 px-3 py-1.5 hover:bg-indigo-50
             hover:text-indigo-700 transition-colors">${esc(sc.text)}</button>`).join('');
}

function pickDeadlineShortcut(index) {
  const sc = DEADLINE_SHORTCUTS[index];
  if (!sc) return;
  _dlValue = _dlShortcutDate(sc);
  _dlMonth = new Date(_dlValue);
  _dlMonth.setDate(1);
  _applyDeadlineValue();
  closeDeadlinePicker();
}

function _renderDeadlineCalendar() {
  const box = document.getElementById('deadline-days');
  const title = document.getElementById('deadline-month');
  if (!box || !_dlMonth) return;

  title.textContent = `${_MONTHS[_dlMonth.getMonth()]} ${_dlMonth.getFullYear()}`;

  const first = new Date(_dlMonth);
  // В России неделя начинается с понедельника, а getDay() — с воскресенья
  const shift = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth() + 1, 0).getDate();
  const today = new Date();

  const cells = [];
  for (let i = 0; i < shift; i++) cells.push('<span></span>');

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth(), day);
    const isToday = _dlSameDay(d, today);
    const isSelected = _dlSameDay(d, _dlValue);
    const isPast = d < new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const cls = isSelected
      ? 'bg-indigo-600 text-white font-semibold'
      : isToday
        ? 'text-indigo-600 font-semibold hover:bg-indigo-50'
        : isPast
          ? 'text-slate-300 hover:bg-slate-100'   // прошлое доступно, но приглушено
          : 'text-slate-700 hover:bg-indigo-50';

    cells.push(`<button type="button" onclick="pickDeadlineDay(${day})"
      class="h-7 rounded text-xs transition-colors ${cls}">${day}</button>`);
  }
  box.innerHTML = cells.join('');
}

function deadlineShiftMonth(delta) {
  if (!_dlMonth) return;
  _dlMonth = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth() + delta, 1);
  _renderDeadlineCalendar();
}

function pickDeadlineDay(day) {
  const time = document.getElementById('deadline-time');
  const [h, m] = (time?.value || '12:00').split(':').map(Number);
  _dlValue = new Date(_dlMonth.getFullYear(), _dlMonth.getMonth(), day, h || 0, m || 0, 0, 0);
  _renderDeadlineCalendar();
  _applyDeadlineValue();
}

function deadlineSetNow() {
  _dlValue = new Date();
  _dlMonth = new Date(_dlValue);
  _dlMonth.setDate(1);
  const time = document.getElementById('deadline-time');
  if (time) {
    time.value = `${String(_dlValue.getHours()).padStart(2, '0')}:${String(_dlValue.getMinutes()).padStart(2, '0')}`;
  }
  _renderDeadlineCalendar();
  _applyDeadlineValue();
}

function confirmDeadline() {
  const time = document.getElementById('deadline-time');
  if (time && time.value) {
    const [h, m] = time.value.split(':').map(Number);
    const base = _dlValue || new Date();
    _dlValue = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h || 0, m || 0, 0, 0);
  }
  _applyDeadlineValue();
  closeDeadlinePicker();
}

// Записывает выбранное значение в скрытое поле и обновляет подпись
function _applyDeadlineValue() {
  const input = document.getElementById('card-deadline-input');
  const label = document.getElementById('deadline-label');
  const clearBtn = document.getElementById('card-deadline-clear');

  if (input) input.value = _dlValue ? _dlValue.toISOString() : '';
  if (label) {
    label.textContent = _dlValue ? _dlFormat(_dlValue) : 'Выберите дату и время';
    label.classList.toggle('text-slate-800', !!_dlValue);
    label.classList.toggle('text-slate-500', !_dlValue);
  }
  if (clearBtn) clearBtn.classList.toggle('hidden', !_dlValue);
  _validateDeadline();
}

// Подставляет значение при открытии карточки
function setDeadlineValue(iso) {
  _dlValue = iso ? new Date(iso) : null;
  if (_dlValue && isNaN(_dlValue)) _dlValue = null;
  _applyDeadlineValue();
}

function clearDeadline() {
  _dlValue = null;
  _applyDeadlineValue();
  closeDeadlinePicker();
}

function _updateDeadlineClearBtn() {
  const clearBtn = document.getElementById('card-deadline-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !_dlValue);
}

// Просрочка больше не блокирует сохранение: это подсказка, а не ошибка.
// Иначе просроченную задачу нельзя было бы отредактировать — клиент
// отправлял обратно истёкший дедлайн и сам себя отклонял.
function _validateDeadline() {
  const errEl = document.getElementById('deadline-error');
  if (!_dlValue) {
    if (errEl) errEl.classList.add('hidden');
    return null;
  }
  if (errEl) errEl.classList.toggle('hidden', _dlValue > new Date());
  return _dlValue.toISOString();
}
