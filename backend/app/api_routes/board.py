import uuid
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_admin
from app.db.models import User
from app.db.session import get_db
from app.services.card_service import CardService
from app.services.column_service import ColumnService
from app.services.project_service import ProjectService
from app.services.user_service import UserService

router = APIRouter(prefix='/board', tags=['board'])

# Псевдо-идентификатор вкладки «Все проекты» — реального проекта за ним нет
GLOBAL_BOARD_ID = '__all__'


@router.get('/init')
async def get_board_init(
    project_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Доска одного проекта.

    Подпроект отдаёт свои колонки и карточки.
    Корневой проект отдаёт свои колонки и карточки, а также секции
    по каждому подпроекту — так выполняется требование «родитель
    показывает задачи всех подпроектов», не смешивая независимые колонки.
    """
    project_service = ProjectService(db)
    card_service = CardService(db)
    column_service = ColumnService(db)

    projects = await project_service.get_tree(current_user)

    if project_id is None:
        default = await project_service.get_default_for(current_user)
        if default is None:
            return {
                'projects': projects,
                'project': None,
                'columns': [],
                'cards': [],
                'sections': [],
                'online_users': await UserService(db).get_online_users(),
                'me': _me(current_user),
            }
        project_id = default.id

    project = await project_service.assert_can_view(project_id, current_user)
    can_manage = await project_service.can_manage_project(project, current_user)

    columns = await column_service.get_all(project.id)
    cards = await card_service.get_all(viewer=current_user, project_ids=[project.id])

    sections = []
    if project.is_root:
        for child in sorted(project.children, key=lambda c: (c.position, c.name)):
            if child.is_archived:
                continue
            visible = await project_service.visible_project_ids(current_user)
            if visible is not None and child.id not in visible:
                continue
            child_cards = await card_service.get_all(viewer=current_user, project_ids=[child.id])
            sections.append({
                'project': {'id': str(child.id), 'name': child.name},
                'columns': await column_service.get_all(child.id),
                'cards': child_cards,
                'can_manage': await project_service.can_manage_project(child, current_user),
            })

    return {
        'projects': projects,
        'project': {
            'id': str(project.id),
            'name': project.name,
            'parent_id': str(project.parent_id) if project.parent_id else None,
            'is_root': project.is_root,
            'can_manage': can_manage,
        },
        'columns': columns,
        'cards': cards,
        'sections': sections,
        'online_users': await UserService(db).get_online_users(),
        'me': _me(current_user),
    }


@router.get('/all')
async def get_global_board(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Сводный дашборд по всем проектам сразу. Только для администратора.

    Своей доски у него нет: колонки принадлежат конкретным проектам,
    поэтому карточки разных проектов нельзя разложить по общему набору
    колонок. Вместо этого отдаём секцию на каждый узел дерева — корневые
    проекты и их подпроекты — с собственными колонками и карточками.
    """
    project_service = ProjectService(db)
    card_service = CardService(db)
    column_service = ColumnService(db)

    projects = await project_service.get_tree(current_user)
    roots = await project_service.repo.get_roots()

    sections = []
    for root in roots:
        if root.is_archived:
            continue
        for node in [root, *sorted(root.children, key=lambda c: (c.position, c.name))]:
            if node.is_archived:
                continue
            sections.append({
                'project': {
                    'id': str(node.id),
                    'name': node.name,
                    'parent_name': root.name if node.parent_id else None,
                },
                'columns': await column_service.get_all(node.id),
                'cards': await card_service.get_all(viewer=current_user, project_ids=[node.id]),
                'can_manage': True,
            })

    return {
        'projects': projects,
        'project': {
            'id': GLOBAL_BOARD_ID,
            'name': 'Все проекты',
            'parent_id': None,
            'is_root': False,
            'is_global': True,
            # Общий вид не привязан к одному проекту, поэтому создавать
            # здесь колонки и задачи нельзя — только открывать карточки.
            'can_manage': False,
        },
        'columns': [],
        'cards': [],
        'sections': sections,
        'online_users': await UserService(db).get_online_users(),
        'me': _me(current_user),
    }


def _me(user: User) -> dict:
    return {
        'user_id': str(user.user_id),
        'username': user.username,
        'role': user.role.value,
    }
