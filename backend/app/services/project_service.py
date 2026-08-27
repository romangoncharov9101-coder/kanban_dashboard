import uuid

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.models import Project, User, UserRole
from app.db.schemas import ProjectCreate, ProjectOut, ProjectUpdate
from app.manager import manager
from app.repositories.column_repo import ColumnRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.user_repo import UserRepository

logger = get_logger('services.project')


class ProjectService:
    """
    Дерево проектов ровно в два уровня: проект → подпроект.

    Видимость:
      ADMIN     — всё дерево.
      TEAM_LEAD — проекты, где он ответственный, вместе с подпроектами,
                  плюс те, где у него есть свои задачи или назначения.
      USER      — только проекты, где ему назначена хотя бы одна задача.
    """

    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = ProjectRepository(session)
        self.user_repo = UserRepository(session)
        self.column_repo = ColumnRepository(session)

    #======================================================
    # Доступ
    #======================================================
    async def visible_project_ids(self, viewer: User) -> set[uuid.UUID] | None:
        """None означает «видит всё» — так админ не тянет лишние запросы."""
        if viewer.role is UserRole.ADMIN:
            return None

        ids: set[uuid.UUID] = set()

        if viewer.role is UserRole.TEAM_LEAD:
            owned = await self.repo.get_owned_project_ids(viewer.user_id)
            ids.update(owned)
            # Ответственный за корневой проект отвечает и за его подпроекты.
            for pid in list(owned):
                ids.update(await self.repo.get_children_ids(pid))
            ids.update(await self.repo.get_project_ids_with_authored_cards(viewer.user_id))

        ids.update(await self.repo.get_project_ids_with_assignments(viewer.user_id))

        # Подпроект показываем вместе с его родителем, иначе в дереве
        # появится висящая ветка без корня.
        for pid in list(ids):
            project = await self.repo.get_by_id(pid)
            if project and project.parent_id:
                ids.add(project.parent_id)

        return ids

    async def can_manage_project(self, project: Project, user: User) -> bool:
        """
        Право вести доску проекта: создавать колонки и задачи.
        Сами проекты создаёт и удаляет только админ.
        """
        if user.role is UserRole.ADMIN:
            return True
        if user.role is not UserRole.TEAM_LEAD:
            return False

        owned = set(await self.repo.get_owned_project_ids(user.user_id))
        if project.id in owned:
            return True
        return project.parent_id is not None and project.parent_id in owned

    async def assert_can_view(self, project_id: uuid.UUID, user: User) -> Project:
        project = await self.repo.get_by_id(project_id)
        if not project:
            raise HTTPException(status_code=404, detail='Проект не найден.')

        visible = await self.visible_project_ids(user)
        if visible is not None and project.id not in visible:
            raise HTTPException(status_code=404, detail='Проект не найден.')
        return project

    async def assert_can_manage(self, project_id: uuid.UUID, user: User) -> Project:
        project = await self.assert_can_view(project_id, user)
        if not await self.can_manage_project(project, user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='Вы не отвечаете за этот проект.',
            )
        return project

    async def scope_ids(self, project: Project) -> list[uuid.UUID]:
        """
        Идентификаторы, по которым собираются карточки для доски.
        Корневой проект показывает свои задачи и задачи всех подпроектов.
        """
        ids = [project.id]
        if project.is_root:
            ids.extend(await self.repo.get_children_ids(project.id))
        return ids

    #======================================================
    # Чтение
    #======================================================
    @staticmethod
    def _node(project: Project, can_manage: bool = False, open_tasks: int = 0,
              children: list[ProjectOut] | None = None) -> ProjectOut:
        """
        Собираем узел вручную. model_validate рекурсивно обошёл бы
        children.children, а второй уровень вложенности не выбирается
        селектом — в асинхронной сессии это падает на ленивой подгрузке.
        """
        return ProjectOut(
            id=project.id,
            name=project.name,
            description=project.description,
            parent_id=project.parent_id,
            position=project.position,
            is_archived=project.is_archived,
            owners=[{'user_id': u.user_id, 'username': u.username} for u in project.owners],
            children=children or [],
            can_manage=can_manage,
            open_tasks=open_tasks,
        )

    async def get_tree(self, viewer: User) -> list[ProjectOut]:
        visible = await self.visible_project_ids(viewer)
        roots = await self.repo.get_roots()

        counts_source: list[uuid.UUID] = []
        for root in roots:
            counts_source.append(root.id)
            counts_source.extend(c.id for c in root.children)
        # Считаем ровно то, что зритель увидит на доске
        counts = await self.repo.count_cards_for_viewer(counts_source, viewer)

        out: list[ProjectOut] = []
        for root in roots:
            children = [c for c in root.children if not c.is_archived]
            if visible is not None:
                children = [c for c in children if c.id in visible]
                root_visible = root.id in visible or bool(children)
            else:
                root_visible = True

            if root.is_archived or not root_visible:
                continue

            child_nodes = [
                self._node(
                    child,
                    can_manage=await self.can_manage_project(child, viewer),
                    open_tasks=counts.get(child.id, 0),
                )
                for child in children
            ]
            out.append(self._node(
                root,
                can_manage=await self.can_manage_project(root, viewer),
                open_tasks=counts.get(root.id, 0),
                children=child_nodes,
            ))

        return out

    async def get_one(self, project_id: uuid.UUID, viewer: User) -> ProjectOut:
        project = await self.assert_can_view(project_id, viewer)
        return self._node(project, can_manage=await self.can_manage_project(project, viewer))

    async def get_default_for(self, viewer: User) -> Project | None:
        """Проект, который открывается при входе, если клиент ничего не выбрал."""
        tree = await self.get_tree(viewer)
        if not tree:
            return None
        first = tree[0]
        # У корня с подпроектами доска сводная — она тоже валидная точка входа.
        return await self.repo.get_by_id(first.id)

    #======================================================
    # Запись (только админ)
    #======================================================
    async def create(self, data: ProjectCreate, actor: User) -> ProjectOut:
        parent = None
        if data.parent_id:
            parent = await self.repo.get_by_id(data.parent_id)
            if not parent:
                raise HTTPException(status_code=404, detail='Родительский проект не найден.')
            if not parent.is_root:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail='Вложенность ограничена одним уровнем: подпроект нельзя вложить в подпроект.',
                )

        owners = await self._resolve_owners(data.owner_ids)

        position = await self.repo.get_max_position(data.parent_id) + 1
        project = await self.repo.create(
            name=data.name,
            parent_id=data.parent_id,
            position=position,
            description=data.description,
            created_by=actor.user_id,
        )

        if owners:
            await self.repo.set_owners(project, [u.user_id for u in owners])
            project = await self.repo.get_by_id(project.id)

        out = self._node(project, can_manage=True)
        await manager.publish('project_created', str(project.id), out.model_dump(mode='json'))
        await self.session.commit()
        logger.info("Project created by %s: %s", actor.username, project.name)
        return out

    async def update(self, project_id: uuid.UUID, data: ProjectUpdate, actor: User) -> ProjectOut:
        project = await self.repo.get_by_id(project_id)
        if not project:
            raise HTTPException(status_code=404, detail='Проект не найден.')

        updates: dict = {}
        if data.name is not None and data.name.strip() and data.name != project.name:
            updates['name'] = data.name.strip()
        if data.description is not None and data.description != project.description:
            updates['description'] = data.description
        if data.position is not None and data.position != project.position:
            updates['position'] = data.position
        if data.is_archived is not None and data.is_archived != project.is_archived:
            updates['is_archived'] = data.is_archived

        owners_changed = False
        if data.owner_ids is not None:
            owners = await self._resolve_owners(data.owner_ids)
            await self.repo.set_owners(project, [u.user_id for u in owners])
            owners_changed = True

        if updates:
            project = await self.repo.update(project, **updates)
        elif owners_changed:
            project = await self.repo.get_by_id(project.id)
        else:
            return self._node(project, can_manage=await self.can_manage_project(project, actor))

        out = self._node(project, can_manage=True)
        await manager.publish('project_updated', str(project.id), out.model_dump(mode='json'))
        await self.session.commit()
        return out

    async def delete(self, project_id: uuid.UUID, actor: User) -> None:
        project = await self.repo.get_by_id(project_id)
        if not project:
            raise HTTPException(status_code=404, detail='Проект не найден.')

        scope = await self.scope_ids(project)
        counts = await self.repo.count_cards(scope)
        total = sum(counts.values())
        if total:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f'В проекте и его подпроектах есть незаархивированные задачи ({total}). '
                    'Удалите или заархивируйте их, либо заархивируйте проект целиком.'
                ),
            )

        name = project.name
        await self.repo.delete(project)
        await manager.publish('project_deleted', str(project_id), {'id': str(project_id), 'name': name})
        await self.session.commit()
        logger.info("Project deleted by %s: %s", actor.username, name)

    async def _resolve_owners(self, owner_ids: list[uuid.UUID]) -> list[User]:
        if not owner_ids:
            return []
        users = await self.user_repo.get_users_by_ids(owner_ids)
        found = {u.user_id for u in users}
        missing = [str(i) for i in owner_ids if i not in found]
        if missing:
            raise HTTPException(status_code=404, detail=f'Пользователь не найден: {", ".join(missing)}')

        bad = [u.username for u in users if u.role not in (UserRole.ADMIN, UserRole.TEAM_LEAD)]
        if bad:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Ответственным можно назначить только постановщика или админа: {", ".join(bad)}',
            )
        inactive = [u.username for u in users if not u.is_active]
        if inactive:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Пользователь деактивирован: {", ".join(inactive)}',
            )
        return users
