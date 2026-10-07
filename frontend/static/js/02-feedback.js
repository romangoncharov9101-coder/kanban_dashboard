'use strict';
// Копирование номеров, тосты, баннер обновления.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// НОМЕРА ЗАДАЧ/КАТЕГОРИЙ — копирование в буфер
// ─────────────────────────────────────────────────────────────────────────────
function copyEntityNumber(event, number, kind, prefix) {
  if (event) event.stopPropagation();
  const text = `${prefix}${number}`;
  const done = () => showToast(`Номер ${kind} ${text} скопирован`, 'success', 1500);
  const fail = () => showToast('Не удалось скопировать номер', 'error');

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      fail();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST / ALERTS
// ─────────────────────────────────────────────────────────────────────────────
// type: 'error' | 'warn' | 'success' | 'info'
function showToast(message, type = 'info', duration = 3000, quite = false) {
  if (quite === true) return;
  const container = document.getElementById('toast-container');
  if (!container) return;

  const currentToasts = Array.from(container.children).filter(t => t.style.opacity !== '0');
  
  if (currentToasts.length >= 3) {
    _removeToast(currentToasts[0]);
  }

  const activeModal = document.querySelector('dialog[open]');
  if (activeModal) {
    if (container.parentElement !== activeModal) {
      activeModal.appendChild(container);
    }
  } else {
    if (container.parentElement !== document.body) {
      document.body.appendChild(container);
    }
  }

  const styles = {
    error:   { bar: 'bg-red-500',    icon: '✕', ring: 'border-red-500',    text: 'text-red-700',    bg: 'bg-red-50'    },
    warn:    { bar: 'bg-amber-400',  icon: '⚠', ring: 'border-amber-400',  text: 'text-amber-700',  bg: 'bg-amber-50'  },
    success: { bar: 'bg-emerald-500',icon: '✓', ring: 'border-emerald-500',text: 'text-emerald-700',bg: 'bg-emerald-50'},
    info:    { bar: 'bg-indigo-500', icon: 'ℹ', ring: 'border-indigo-500', text: 'text-indigo-700', bg: 'bg-indigo-50' },
  };

  const s = styles[type] || styles.info;
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto border ${s.ring} ${s.bg} rounded-xl shadow-xl flex overflow-hidden animate-slide-in`;

  const bar = document.createElement('div');
  bar.className = `${s.bar} w-1.5 flex-shrink-0`;

  const body = document.createElement('div');
  body.className = 'flex items-start gap-3 px-4 py-3 flex-1 min-w-0';

  const iconEl = document.createElement('span');
  iconEl.className = `${s.text} font-bold text-base mt-0.5 flex-shrink-0`;
  iconEl.textContent = s.icon;
 
  const msgEl = document.createElement('span');
  msgEl.className = 'text-sm text-slate-700 flex-1 min-w-0 break-words';
  msgEl.textContent = message;
 
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-slate-400 hover:text-slate-600 ml-1 flex-shrink-0 text-lg leading-none';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => _removeToast(toast);
 
  body.appendChild(iconEl);
  body.appendChild(msgEl);
  body.appendChild(closeBtn);
  toast.appendChild(bar);
  toast.appendChild(body);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => _removeToast(toast), duration);
  }
  return toast;
}

const toast = {
  error:   (m, d) => showToast(m, 'error', d),
  warn:    (m, d) => showToast(m, 'warn', d),
  success: (m, d) => showToast(m, 'success', d),
  info:    (m, d) => showToast(m, 'info', d),
}

function _removeToast(toast) {
  toast.style.cssText = 'opacity:0;transform:translateX(120%);transition:all .3s ease';
  setTimeout(() => toast.remove(), 320);
}

// ─────────────────────────────────────────────────────────────────────────────
// БАННЕР «ДОСТУПНО ОБНОВЛЕНИЕ»
// ─────────────────────────────────────────────────────────────────────────────
// Приходит по WS (событие 'app_updated'), когда версия scripts.js на сервере
// разошлась с той, с которой была загружена текущая вкладка — то есть был
// деплой. Не перезагружаем страницу сами (пользователь может редактировать
// карточку), а показываем постоянный тост с кнопкой «Обновить».
let _appUpdateBannerShown = false;

function showAppUpdateBanner() {
  if (_appUpdateBannerShown) return;
  _appUpdateBannerShown = true;

  const container = document.getElementById('toast-container');
  if (!container) { location.reload(); return; }

  const banner = document.createElement('div');
  banner.className = 'pointer-events-auto border border-indigo-500 bg-indigo-50 rounded-xl shadow-xl flex overflow-hidden animate-slide-in';

  const bar = document.createElement('div');
  bar.className = 'bg-indigo-500 w-1.5 flex-shrink-0';

  const body = document.createElement('div');
  body.className = 'flex items-center gap-3 px-4 py-3 flex-1 min-w-0';

  const msgEl = document.createElement('span');
  msgEl.className = 'text-sm text-indigo-800 flex-1 min-w-0';
  msgEl.textContent = 'Доступна новая версия приложения';

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'bg-indigo-600 text-white text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-indigo-700 flex-shrink-0';
  reloadBtn.textContent = 'Обновить';
  reloadBtn.onclick = () => location.reload();

  body.appendChild(msgEl);
  body.appendChild(reloadBtn);
  banner.appendChild(bar);
  banner.appendChild(body);
  container.appendChild(banner);
  // Намеренно без auto-dismiss и без кнопки «×» — предупреждение важное,
  // пусть висит, пока пользователь сам не обновится.
}
 