'use strict';
// Проекты: создание и настройка состава.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// ПРОЕКТЫ: создание и настройка (только ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
function _findProject(id) {
  for (const root of projects) {
    if (String(root.id) === String(id)) return root;
    for (const child of (root.children || [])) {
      if (String(child.id) === String(id)) return child;
    }
  }
  return null;
}

async function openProjectModal(projectId, parentId) {
  if (!isAdmin()) return toast.warn('Проекты создаёт администратор');

  const existing = projectId ? _findProject(projectId) : null;
  selectedOwners = existing ? (existing.owners || []).map(o => ({ ...o })) : [];
  selectedMembers = existing ? (existing.members || []).map(m => ({ ...m })) : [];
  selectedManagers = existing ? (existing.managers || []).map(m => ({ ...m })) : [];

  document.getElementById('project-edit-id').value = projectId || '';
  document.getElementById('project-parent-id').value = parentId || '';
  document.getElementById('project-name').value = existing ? existing.name : '';
  document.getElementById('project-description').value = existing ? (existing.description || '') : '';

  document.getElementById('modal-project-title').textContent =
    existing ? 'Настройки проекта' : (parentId ? 'Новый подпроект' : 'Новый проект');

  const delBtn = document.getElementById('project-delete-btn');
  if (delBtn) delBtn.style.display = existing ? '' : 'none';

  // Ответственный назначается на проект целиком; у подпроекта он наследуется
  // Настройки проекта и подпроекта одинаковы: состав задаётся на любом
  // уровне, при этом участники корня наследуются его подпроектами.
  const ownersBlock = document.getElementById('project-owners-block');
  if (ownersBlock) ownersBlock.style.display = '';

  _renderOwnerChips();
  _renderMemberChips();
  _renderManagerChips();
  // Подсказка зависит от уровня: руководитель всего проекта управляет
  // и подпроектами, и может назначать их руководителей исполнителями.
  const managersHint = document.getElementById('project-managers-hint');
  if (managersHint) {
    const isSub = !!(parentId || existing?.parent_id);
    managersHint.textContent = isSub
      ? 'Руководитель подпроекта создаёт в нём колонки и задачи и назначает исполнителями постановщиков и ответственных.'
      : 'Руководитель проекта ведёт проект и все подпроекты: создаёт колонки и задачи, назначает исполнителями постановщиков, ответственных и руководителей подпроектов.';
  }
  await _fillOwnerOptions();
  await _fillMemberOptions();
  await _fillManagerOptions();

  document.getElementById('modal-project').showModal();
  setTimeout(() => document.getElementById('project-name').focus(), 50);
}

async function _fillOwnerOptions() {
  const sel = document.getElementById('project-owner-select');
  if (!sel) return;
  const users = await api('GET', '/admin/users', undefined, true);
  const eligible = (users || []).filter(u =>
    u.is_active && (u.role === 'TEAM_LEAD' || u.role === 'ADMIN'));

  sel.innerHTML = '<option value="">Добавить постановщика…</option>' +
    eligible
      .filter(u => !selectedOwners.some(o => String(o.user_id) === String(u.user_id)))
      .map(u => `<option value="${u.user_id}|${esc(u.username)}">${esc(u.username)}</option>`)
      .join('');
}

async function _fillMemberOptions() {
  const sel = document.getElementById('project-member-select');
  if (!sel) return;
  const users = await api('GET', '/admin/users', undefined, true);
  // Ответственным можно назначить только пользователя с ролью «Исполнитель»
  const eligible = (users || []).filter(u => u.is_active && u.role === 'USER');

  sel.innerHTML = '<option value="">Добавить исполнителя…</option>' +
    eligible
      .filter(u => !selectedMembers.some(m => String(m.user_id) === String(u.user_id)))
      .map(u => `<option value="${u.user_id}|${esc(u.username)}">${esc(u.username)}</option>`)
      .join('');
}

async function _fillManagerOptions() {
  const sel = document.getElementById('project-manager-select');
  if (!sel) return;
  const users = await api('GET', '/admin/users', undefined, true);
  // Руководителем назначается только пользователь с ролью «Руководитель»
  const eligible = (users || []).filter(u => u.is_active && u.role === 'PROJECT_MANAGER');

  sel.innerHTML = '<option value="">Добавить руководителя…</option>' +
    eligible
      .filter(u => !selectedManagers.some(m => String(m.user_id) === String(u.user_id)))
      .map(u => `<option value="${u.user_id}|${esc(u.username)}">${esc(u.username)}</option>`)
      .join('');
}

function addProjectManager(value) {
  if (!value) return;
  const [id, username] = value.split('|');
  if (selectedManagers.some(m => String(m.user_id) === String(id))) return;
  selectedManagers.push({ user_id: id, username });
  _renderManagerChips();
  _fillManagerOptions();
}

function removeProjectManager(userId) {
  selectedManagers = selectedManagers.filter(m => String(m.user_id) !== String(userId));
  _renderManagerChips();
  _fillManagerOptions();
}

function _renderManagerChips() {
  const box = document.getElementById('project-manager-chips');
  if (!box) return;
  box.innerHTML = selectedManagers.map(m => `
    <span class="inline-flex items-center gap-1 bg-amber-50 text-amber-700 border border-amber-200
                 rounded-full pl-2.5 pr-1 py-0.5 text-xs font-medium">
      ${esc(m.username)}
      <button type="button" onclick="removeProjectManager('${m.user_id}')"
        class="text-amber-400 hover:text-red-500 leading-none text-sm px-0.5">&times;</button>
    </span>`).join('');
}

function addProjectMember(value) {
  if (!value) return;
  const [id, username] = value.split('|');
  if (selectedMembers.some(m => String(m.user_id) === String(id))) return;
  selectedMembers.push({ user_id: id, username });
  _renderMemberChips();
  _fillMemberOptions();
}

function removeProjectMember(userId) {
  selectedMembers = selectedMembers.filter(m => String(m.user_id) !== String(userId));
  _renderMemberChips();
  _fillMemberOptions();
}

function _renderMemberChips() {
  const box = document.getElementById('project-member-chips');
  if (!box) return;
  box.innerHTML = selectedMembers.map(m => `
    <span class="inline-flex items-center gap-1.5 bg-white border border-slate-200 shadow-sm
                 rounded-full pl-1 pr-1 py-1 text-xs">
      <span class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold
                   ${_avatarColor(m.username)}">${esc(_initials(m.username))}</span>
      <span class="text-slate-700 font-medium">${esc(m.username)}</span>
      <button type="button" onclick="removeProjectMember('${m.user_id}')"
        class="w-4 h-4 rounded-full flex items-center justify-center text-slate-400
               hover:bg-red-50 hover:text-red-500 transition-colors" title="Убрать">&times;</button>
    </span>`).join('');
}

function addProjectOwner(value) {
  if (!value) return;
  const [id, username] = value.split('|');
  if (selectedOwners.some(o => String(o.user_id) === String(id))) return;
  selectedOwners.push({ user_id: id, username });
  _renderOwnerChips();
  _fillOwnerOptions();
}

function removeProjectOwner(userId) {
  selectedOwners = selectedOwners.filter(o => String(o.user_id) !== String(userId));
  _renderOwnerChips();
  _fillOwnerOptions();
}

function _renderOwnerChips() {
  const box = document.getElementById('project-owner-chips');
  if (!box) return;
  box.innerHTML = selectedOwners.map(o => `
    <span class="inline-flex items-center gap-1 bg-violet-50 text-violet-700 border border-violet-200
                 rounded-full pl-2.5 pr-1 py-0.5 text-xs font-medium">
      ${esc(o.username)}
      <button type="button" onclick="removeProjectOwner('${o.user_id}')"
        class="text-violet-400 hover:text-red-500 leading-none text-sm px-0.5">&times;</button>
    </span>`).join('');
}

async function submitProject() {
  const id = document.getElementById('project-edit-id').value;
  const parentId = document.getElementById('project-parent-id').value;
  const name = document.getElementById('project-name').value.trim();
  const description = document.getElementById('project-description').value.trim() || null;

  const projectNameError = validateName(name, 150, 'Название проекта');
  if (projectNameError) return toast.warn(projectNameError);

  const ownerIds = selectedOwners.map(o => o.user_id);
  const memberIds = selectedMembers.map(m => m.user_id);
  const managerIds = selectedManagers.map(m => m.user_id);
  let result;

  // Проект и подпроект настраиваются одинаково: состав задаётся
  // на любом уровне, поэтому отдельной ветки для подпроекта нет.
  if (id) {
    result = await api('PATCH', `/projects/${id}`, {
      name, description, owner_ids: ownerIds, member_ids: memberIds, manager_ids: managerIds,
    });
  } else {
    const payload = { name, description, owner_ids: ownerIds, member_ids: memberIds, manager_ids: managerIds };
    if (parentId) payload.parent_id = parentId;
    result = await api('POST', '/projects', payload);
  }

  if (!result) return;
  document.getElementById('modal-project').close();
  toast.success(id ? 'Проект обновлён' : 'Проект создан');

  if (!id) currentProject = { id: result.id };
  await loadBoard();
}

async function deleteProject() {
  const id = document.getElementById('project-edit-id').value;
  if (!id) return;
  const p = _findProject(id);
  if (!confirm(`Удалить проект «${p ? p.name : ''}»? Подпроекты и их категории будут удалены вместе с ним.`)) return;

  const res = await api('DELETE', `/projects/${id}`);
  if (res === null) return;

  document.getElementById('modal-project').close();
  toast.success('Проект удалён');
  if (currentProject && String(currentProject.id) === String(id)) currentProject = null;
  await loadBoard();
}
