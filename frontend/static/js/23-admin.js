'use strict';
// Управление пользователями.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PANEL (только роль ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
let adminUsers = [];

async function openAdminPanel() {
  if (!isAdmin()) return toast.warn('Доступно только администратору');

  document.getElementById('admin-new-username').value = '';
  document.getElementById('admin-new-password').value = '';
  document.getElementById('admin-new-role').value = 'USER';
  document.getElementById('modal-admin').showModal();
  await loadAdminUsers();
}

async function loadAdminUsers() {
  const box = document.getElementById('admin-users-list');
  box.innerHTML = '<p class="text-center text-slate-400 text-xs py-4">Загрузка…</p>';

  const users = await api('GET', '/admin/users');
  if (!users) {
    box.innerHTML = '<p class="text-center text-red-400 text-xs py-4">Не удалось загрузить список</p>';
    return;
  }
  adminUsers = users;
  _renderAdminUsers();
}

function _renderAdminUsers() {
  const box = document.getElementById('admin-users-list');
  if (!adminUsers.length) {
    box.innerHTML = '<p class="text-center text-slate-400 text-xs py-4">Пользователей нет</p>';
    return;
  }

  box.innerHTML = adminUsers.map(u => {
    const role = ROLE_LABELS[u.role] || ROLE_LABELS.USER;
    const isMe = String(u.user_id) === String(currentUser?.user_id);
    const dimmed = u.is_active ? '' : 'opacity-50';

    return `
      <div class="flex flex-wrap items-center gap-2 border border-slate-200 rounded-xl px-3 py-2 ${dimmed}">
        <span class="w-2 h-2 rounded-full flex-shrink-0 ${u.online ? 'bg-emerald-500' : 'bg-slate-300'}"
              title="${u.online ? 'В сети' : 'Не в сети'}"></span>

        <span class="font-medium text-sm text-slate-800 truncate flex-1 min-w-[100px]">
          ${esc(u.username)}
          ${isMe ? '<span class="text-[10px] text-slate-400 font-normal">(вы)</span>' : ''}
          ${!u.is_active ? '<span class="text-[10px] text-red-500 font-normal">деактивирован</span>' : ''}
        </span>

        <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${role.cls}">${role.text}</span>

        <select onchange="changeUserRole('${u.user_id}', this.value)" ${isMe ? 'disabled' : ''}
          class="border border-slate-300 rounded-lg px-2 py-1 text-xs bg-white disabled:opacity-40 disabled:cursor-not-allowed">
          <option value="USER"      ${u.role === 'USER' ? 'selected' : ''}>Пользователь</option>
          <option value="TEAM_LEAD" ${u.role === 'TEAM_LEAD' ? 'selected' : ''}>Тим лидер</option>
          <option value="ADMIN"     ${u.role === 'ADMIN' ? 'selected' : ''}>Администратор</option>
        </select>

        <button onclick="resetUserPassword('${u.user_id}', '${esc(u.username)}')"
          class="text-xs text-slate-500 hover:text-indigo-600 border border-slate-200 rounded-lg px-2 py-1"
          title="Задать новый пароль">🔑</button>

        ${u.is_active
          ? `<button onclick="setUserActive('${u.user_id}', false)" ${isMe ? 'disabled' : ''}
               class="text-xs text-slate-400 hover:text-red-500 border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
               title="Деактивировать">✕</button>`
          : `<button onclick="setUserActive('${u.user_id}', true)"
               class="text-xs text-emerald-600 hover:text-emerald-700 border border-emerald-200 rounded-lg px-2 py-1"
               title="Вернуть доступ">↺</button>`}
      </div>`;
  }).join('');
}

async function submitNewUser() {
  const username = document.getElementById('admin-new-username').value.trim();
  const password = document.getElementById('admin-new-password').value;
  const role     = document.getElementById('admin-new-role').value;

  if (!username) return toast.warn('Укажите логин');
  if (password.length < 6) return toast.warn('Пароль: минимум 6 символов');

  const created = await api('POST', '/admin/users', { username, password, role });
  if (!created) return;

  document.getElementById('admin-new-username').value = '';
  document.getElementById('admin-new-password').value = '';
  toast.success(`Пользователь ${created.username} создан`);
  await loadAdminUsers();
}

async function changeUserRole(userId, role) {
  const updated = await api('PATCH', `/admin/users/${userId}`, { role });
  if (!updated) { await loadAdminUsers(); return; }
  toast.success(`Роль изменена: ${(ROLE_LABELS[role] || {}).text || role}`);
  // Смена роли обрывает сессии пользователя — он будет вынужден войти заново
  await loadAdminUsers();
}

async function resetUserPassword(userId, username) {
  const password = prompt(`Новый пароль для «${username}» (минимум 6 символов):`);
  if (password === null) return;
  if (password.length < 6) return toast.warn('Пароль: минимум 6 символов');

  const updated = await api('PATCH', `/admin/users/${userId}`, { password });
  if (!updated) return;
  toast.success('Пароль обновлён, активные сессии сброшены');
}

async function setUserActive(userId, isActive) {
  if (!isActive && !confirm('Деактивировать пользователя? Он не сможет войти, а его сессии будут сброшены.')) return;

  const updated = await api('PATCH', `/admin/users/${userId}`, { is_active: isActive });
  if (!updated) { await loadAdminUsers(); return; }
  toast.success(isActive ? 'Доступ восстановлен' : 'Пользователь деактивирован');
  await loadAdminUsers();
}