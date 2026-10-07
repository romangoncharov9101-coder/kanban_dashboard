'use strict';
// Уведомления.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
function showNotification(payload) {
  const container = _getToastContainer();
  
  const priorityMap = {
    'HIGHT': { color: 'bg-red-500', text: 'Высокий', bg: 'bg-red-50', textColor: 'text-red-700' },
    'MEDIUM': { color: 'bg-amber-500', text: 'Средний', bg: 'bg-amber-50', textColor: 'text-amber-700' },
    'LOW': { color: 'bg-slate-400', text: 'Низкий', bg: 'bg-slate-50', textColor: 'text-slate-600' }
  };
  const p = priorityMap[payload.priority] || priorityMap['LOW'];

  const toast_ = document.createElement('div');
  toast_.className = `pointer-events-auto border border-slate-200 ${p.bg} rounded-xl shadow-xl flex flex-col overflow-hidden animate-slide-in w-72`;

  const topPart = document.createElement('div');
  topPart.className = 'flex flex-1';

  const bar = document.createElement('div');
  bar.className = `${p.color} w-1.5 flex-shrink-0`;

  const body = document.createElement('div');
  body.className = 'px-4 py-3 flex flex-col gap-1 flex-1 min-w-0';

  const header = document.createElement('div');
  header.className = 'flex justify-between items-center';
  
  const label = document.createElement('span');
  label.className = `${p.textColor} font-bold text-[10px] uppercase tracking-widest`;
  label.textContent = `Новая задача • ${p.text}`;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-slate-400 hover:text-slate-600 text-lg leading-none';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => _removeToast(toast_);
  
  header.appendChild(label); 
  header.appendChild(closeBtn);

  const titleEl = document.createElement('div');
  titleEl.className = 'text-slate-800 font-semibold text-sm';
  titleEl.textContent = payload.card_title || 'Без названия';

  const fromEl = document.createElement('div');
  fromEl.className = 'text-slate-500 text-xs';
  fromEl.textContent = 'Назначил: ';
  const fromName = document.createElement('span');
  fromName.className = 'font-medium text-slate-700';
  fromName.textContent = payload.from_user || 'Система';
  fromEl.appendChild(fromName);

  body.appendChild(header); 
  body.appendChild(titleEl); 
  body.appendChild(fromEl);
  topPart.appendChild(bar); 
  topPart.appendChild(body);
  toast_.appendChild(topPart);

  const actions = document.createElement('div');
  actions.className = 'px-4 pb-3 flex flex-col gap-2';

  const btnShow = document.createElement('button');
  btnShow.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold py-2 rounded-lg transition-colors shadow-sm';
  btnShow.textContent = 'Показать мои задачи';
  btnShow.onclick = () => {
    const fSelect = document.getElementById('filter-select');
    if (fSelect) fSelect.value = 'my';
    _removeToast(toast_);
  };

  actions.appendChild(btnShow);
  toast_.appendChild(actions);

  container.appendChild(toast_);

  setTimeout(() => {
    if (toast_.parentElement) _removeToast(toast_);
  }, 6000);
}

async function showOfflineNotification() {
  const container = _getToastContainer();
  const t = document.createElement('div');
  t.className = 'pointer-events-auto border-2 border-indigo-400 bg-indigo-50 rounded-xl shadow-2xl p-4 animate-bounce-in flex flex-col gap-3 w-72';
 
  const row = document.createElement('div');
  row.className = 'flex items-center gap-3';
 
  const iconBox = document.createElement('div');
  iconBox.className = 'bg-indigo-500 text-white p-2 rounded-lg flex-shrink-0 text-lg';
  iconBox.textContent = '🔔';
 
  const textBox = document.createElement('div');
  const h4 = document.createElement('h4');
  h4.className = 'font-bold text-slate-900 text-sm';
  h4.textContent = 'Пока вас не было…';
  const p = document.createElement('p');
  p.className = 'text-slate-600 text-xs';
  p.textContent = 'Вам назначены новые задачи!';
  textBox.appendChild(h4); textBox.appendChild(p);
 
  row.appendChild(iconBox); row.appendChild(textBox);
  t.appendChild(row);

  const actions = document.createElement('div');
  actions.className = 'flex flex-col gap-2';

  const btnShow = document.createElement('button');
  btnShow.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold py-2 rounded-lg transition-colors';
  btnShow.textContent = 'Показать мои задачи';
  btnShow.onclick = async () => {
    await api('DELETE', '/notifications/clear');
    const fSelect = document.getElementById('filter-select');
    if (fSelect) fSelect.value = 'my';
    await changeFilterMode('my');
    _removeToast(t);
  };
 
  const btnOk = document.createElement('button');
  btnOk.className = 'w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 rounded-lg transition-colors';
  btnOk.textContent = 'Понятно, спасибо!';
  btnOk.onclick = async () => {
    await api('DELETE', '/notifications/clear');

    if (currentUser && currentUser.user_id) {
      const allCards = document.querySelectorAll('.card');
      allCards.forEach(cardEl => {
        const cardId = cardEl.dataset.cardId;
        const cardData = findCardById(cardId);
        
        if (cardData && (cardData.assignees || []).some(a => String(a.user_id) === String(currentUser.user_id))) {
          cardEl.classList.add('ring-4', 'ring-emerald-400', 'shadow-emerald-200');
          
          setTimeout(() => {
            cardEl.classList.remove('ring-4', 'ring-emerald-400', 'shadow-emerald-200');
          }, 2000);
        }
      });
    }

    _removeToast(t);
  };
 
  actions.appendChild(btnShow);
  actions.appendChild(btnOk);
  t.appendChild(actions);
  container.prepend(t);
}

function _getToastContainer() {
  let c = document.getElementById('toast-container');
  const activeModal = document.querySelector('dialog[open]');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none w-80 max-w-[calc(100vw-2rem)]';
    document.body.appendChild(c);
  }

  if (activeModal && c.parentElement !== activeModal) {
    activeModal.appendChild(c);
  } else if (!activeModal && c.parentElement !== document.body) {
    document.body.appendChild(c);
  }
  return c;
}
 