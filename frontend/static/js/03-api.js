'use strict';
// HTTP-обёртка над API, лог, экранирование.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// API helper
// ─────────────────────────────────────────────────────────────────────────────
async function api(method, path, body, quite = false) {
  const opts = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(API+path, opts);
  if (res.status === 204) return null;
  let json = null;
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
      try {
          json = await res.json();
      } catch (e) {
          console.warn("Не удалось распарсить JSON", e);
      }
  }

  if (!res.ok) {
    if (res.status === 401) {
      const wasLoggedIn = !!currentUser;
      _uiLoggedOut();
      if (path === '/users/login') {
        const errMsg = json?.detail || json?.message || 'Неверный логин или пароль';
        toast.error(errMsg);
        return null;
      }
      if (!wasLoggedIn || quite) return null; 
      return null;
    }
    if (!quite) {
        const errMsg = json?.error?.message || json?.detail?.[0]?.msg
                   || json?.detail || json?.message || `Ошибка ${res.status}`;
        toast.error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), quite);
      }
      return null;
  }

  return json;
}

async function apiUpload(path, formData) {
  const res = await fetch(API + path, {method: 'POST', credentials: 'include', body: formData});

  if (res.status === 204) return null;
  const json = await res.json();

  if(!res.ok) {
    const errMsg = json?.error?.message || json?.detail || `Ошибка ${res.status}`;
    toast.error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), quite=true);
    return null;
  }
  return json;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// LOG
// ─────────────────────────────────────────────────────────────────────────────
function logEvent(type, msg) {
  const colors = {
    card_created:'text-emerald-600', card_updated:'text-blue-600',
    card_moved:'text-purple-600',  card_deleted:'text-red-500',
    card_dragging:'text-amber-500',
    column_created:'text-emerald-700', column_updated:'text-blue-700', column_deleted:'text-red-600',
    user_online:'text-emerald-500', user_offline:'text-slate-400',
    session_invalidated:'text-orange-500',
    error:'text-red-700', system:'text-slate-400',
  };

  // Панель логов на доске убрана: история действий живёт на вкладке
  // «Журнал действий» и в файловом архиве на сервере. Здесь оставляем
  // только вывод в консоль браузера для отладки WebSocket.
  const el = document.getElementById('event-log');
  if (el) {
    el.insertAdjacentHTML('afterbegin',
      `<div class="${colors[type] || 'text-slate-600'}">[${new Date().toLocaleTimeString()}] <b>${type}</b> ${esc(String(msg).substring(0, 120))}</div>`);
    while (el.children.length > 100) el.lastChild.remove();
  }
}
function clearLog() {
  const el = document.getElementById('event-log');
  if (el) el.innerHTML = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// ESCAPE (XSS protection)
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
 