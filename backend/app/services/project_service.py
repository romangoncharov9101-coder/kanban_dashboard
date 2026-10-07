import uuid

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.models import EventType, Project, User, UserRole
from app.db.schemas import ProjectCreate, ProjectOut, ProjectUpdate
from app.manager import manager
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
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
      PROJECT_MANAGER — проекты, где он руководитель, вместе с подпроектами
                  (если руководит корневым), плюс те, где у него есть свои
                  задачи или назначения.
      USER      — только проекты, где ему назначена хотя бы одна задача.
    """

    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = ProjectRepository(session)
        self.user_repo = UserRepository(session)
        self.column_repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)

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

        if viewer.role is UserRole.PROJECT_MANAGER:
            managed = await self.repo.get_managed_project_ids(viewer.user_id)
            ids.update(managed)
            # Руководитель всего проекта руководит и его подпроектами.
            for pid in list(managed):
                ids.update(await self.repo.get_children_ids(pid))
        # Ответственный исполнитель видит проект целиком, даже пока
        # ему не назначили ни одной задачи.
        # Ответственность не наследуется вниз: подпроекты родительского
        # проекта не открываются автоматически, туда назначают отдельно.
        member_of = await self.repo.get_member_project_ids(viewer.user_id)
        ids.update(member_of)

        ids.update(await self.repo.get_project_ids_with_assignments(viewer.user_id))
        ids.update(await self.repo.get_project_ids_with_authored_cards(viewer.user_id))

        # Личная категория сама по себе видимость не даёт: пока в ней нет
        # задачи, назначенной именно этому исполнителю, ни она, ни проект
        # ради неё одной не показываются. Первую задачу туда заводит
        # постановщик или админ — после этого проект и колонка появятся
        # у исполнителя сами (см. также фильтр колонок в ColumnService).
        if viewer.role is UserRole.USER:
            ids.update(await self.repo.get_project_ids_with_own_creatable_assignment(viewer.user_id))

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
        if user.role is UserRole.TEAM_LEAD:
            owned = set(await self.repo.get_owned_project_ids(user.user_id))
        elif user.role is UserRole.PROJECT_MANAGER:
            # Руководитель ведёт доску там, где назначен, а руководитель
            # корневого проекта — ещё и доски всех его подпроектов.
            owned = set(await self.repo.get_managed_project_ids(user.user_id))
        else:
            return False

        if project.id in owned:
            return True
        return project.parent_id is not None and project.parent_id in owned

    async def manages_whole_project(self, project: Project, user: User) -> bool:
        """
        Руководитель корневого проекта, в который входит этот узел.
        Только такой руководитель может назначать исполнителями
        руководителей подпроектов.
        """
        if user.role is not UserRole.PROJECT_MANAGER:
            return False
        root_id = project.parent_id or project.id
        return root_id in set(await self.repo.get_managed_project_ids(user.user_id))

    async def assignable_user_ids(self, project: Project, actor: User) -> set[uuid.UUID] | None:
        """
        Кого актёр вправе назначать исполнителем задачи в этом проекте.
        None — ограничений нет (админ и постановщик работают как раньше).

        Руководитель назначает только постановщиков и ответственных того
        узла, где лежит задача (постановщики корня действуют и в подпроектах). Руководитель всего проекта дополнительно
        может назначать руководителей подпроектов: на доске корня — любого
        из подпроектов, на доске подпроекта — руководителей этого подпроекта.
        """
        if actor.role is not UserRole.PROJECT_MANAGER:
            return None

        ids: set[uuid.UUID] = set(await self.repo.get_owner_ids(project.id))
        ids.update(await self.repo.get_member_ids(project.id))
        # Постановщик корневого проекта ведёт и все его подпроекты,
        # поэтому в подпроекте он тоже считается постановщиком.
        # Ответственные же не наследуются (см. is_project_member).
        if project.parent_id:
            ids.update(await self.repo.get_owner_ids(project.parent_id))

        if await self.manages_whole_project(project, actor):
            if project.is_root:
                for child in project.children or []:
                    if not child.is_archived:
                        ids.update(await self.repo.get_manager_ids(child.id))
            else:
                ids.update(await self.repo.get_manager_ids(project.id))
        return ids

    async def get_assignable(self, project_id: uuid.UUID, actor: User) -> dict:
        """
        Для клиента: ограничен ли выбор исполнителей и кем именно.
        Деактивированных не отдаём — назначить их всё равно нельзя.
        """
        project = await self.assert_can_view(project_id, actor)
        ids = await self.assignable_user_ids(project, actor)
        if ids is None:
            return {'restricted': False, 'users': []}
        users = await self.user_repo.get_users_by_ids(list(ids)) if ids else []
        users = sorted((u for u in users if u.is_active), key=lambda u: u.username.lower())
        return {'restricted': True, 'users': users}

    async def is_project_member(self, project: Project, user: User) -> bool:
        """
        Ответственный исполнитель именно этого узла дерева.

        Ответственность НЕ наследуется: за проект и за его подпроект
        отвечают разные люди. Ответственный за родительский проект
        не работает в подпроекте — не попадает в исполнителей его задач
        и не создаёт там свои, даже если категория открыта.
        """
        member_of = set(await self.repo.get_member_project_ids(user.user_id))
        return project.id in member_of

    async def get_member_ids_for_card(self, project_id: uuid.UUID) -> list[uuid.UUID]:
        """
        Ответственные этого проекта — только свои.
        Состав родителя сюда не подмешивается: у подпроекта своя команда.
        """
        project = await self.repo.get_by_id(project_id)
        if not project:
            return []
        return list(await self.repo.get_member_ids(project.id))

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
            members=[{'user_id': u.user_id, 'username': u.username} for u in project.members],
            managers=[{'user_id': u.user_id, 'username': u.username} for u in project.managers],
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
        members = await self._resolve_members(data.member_ids)
        managers = await self._resolve_managers(data.manager_ids)

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
        if members:
            await self.repo.set_members(project, [u.user_id for u in members])
        if managers:
            await self.repo.set_managers(project, [u.user_id for u in managers])
        if owners or members or managers:
            project = await self.repo.get_by_id(project.id)

        out = self._node(project, can_manage=True)
        kind = 'подпроект' if parent else 'проект'
        where = f' в проекте «{parent.name}»' if parent else ''
        who = ', '.join(u.username for u in owners)
        heads = ', '.join(u.username for u in managers)
        await self.event_repo.create(
            event_type=EventType.PROJECT_CREATED,
            message=f'Создал {kind} «{project.name}»{where}'
                    + (f'; ответственные: {who}' if who else '')
                    + (f'; руководители: {heads}' if heads else ''),
            actor=actor,
            project_id=project.id,
            project_name=project.name,
            payload=out.model_dump(mode='json'),
        )
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

        if data.member_ids is not None:
            members = await self._resolve_members(data.member_ids)
            await self.repo.set_members(project, [u.user_id for u in members])
            owners_changed = True

        if data.manager_ids is not None:
            managers = await self._resolve_managers(data.manager_ids)
            await self.repo.set_managers(project, [u.user_id for u in managers])
            owners_changed = True

        if updates:
            project = await self.repo.update(project, **updates)
        elif owners_changed:
            project = await self.repo.get_by_id(project.id)
        else:
            return self._node(project, can_manage=await self.can_manage_project(project, actor))

        out = self._node(project, can_manage=True)
        changes = []
        if 'name' in updates:
            changes.append(f'переименовал в «{updates["name"]}»')
        if 'description' in updates:
            changes.append('изменил описание')
        if 'is_archived' in updates:
            changes.append('отправил в архив' if updates['is_archived'] else 'вернул из архива')
        if owners_changed:
            leads = ', '.join(u.username for u in project.owners) or 'никого'
            execs = ', '.join(u.username for u in project.members) or 'никого'
            heads = ', '.join(u.username for u in project.managers) or 'никого'
            changes.append(f'постановщики: {leads}; ответственные: {execs}; руководители: {heads}')

        await self.event_repo.create(
            event_type=EventType.PROJECT_UPDATED,
            message=f'Проект «{project.name}»: ' + ('; '.join(changes) or 'без изменений'),
            actor=actor,
            project_id=project.id,
            project_name=project.name,
            payload=out.model_dump(mode='json'),
        )
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
        kind = 'подпроект' if project.parent_id else 'проект'
        child_count = len(project.children or [])
        await self.repo.delete(project)
        await self.event_repo.create(
            event_type=EventType.PROJECT_DELETED,
            message=f'Удалил {kind} «{name}»'
                    + (f' вместе с {child_count} подпроектами' if child_count else ''),
            actor=actor,
            project_name=name,
        )
        await manager.publish('project_deleted', str(project_id), {'id': str(project_id), 'name': name})
        await self.session.commit()
        logger.info("Project deleted by %s: %s", actor.username, name)

    async def _resolve_members(self, member_ids: list[uuid.UUID]) -> list[User]:
        """Ответственным исполнителем можно назначить только роль «Исполнитель»."""
        if not member_ids:
            return []
        users = await self.user_repo.get_users_by_ids(member_ids)
        found = {u.user_id for u in users}
        missing = [str(i) for i in member_ids if i not in found]
        if missing:
            raise HTTPException(status_code=404, detail=f'Пользователь не найден: {", ".join(missing)}')

        bad = [u.username for u in users if u.role is not UserRole.USER]
        if bad:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Ответственным можно назначить только исполнителя: {", ".join(bad)}',
            )
        inactive = [u.username for u in users if not u.is_active]
        if inactive:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Пользователь деактивирован: {", ".join(inactive)}',
            )
        return users

    async def _resolve_managers(self, manager_ids: list[uuid.UUID]) -> list[User]:
        """Руководителем проекта можно назначить только роль «Руководитель»."""
        if not manager_ids:
            return []
        users = await self.user_repo.get_users_by_ids(manager_ids)
        found = {u.user_id for u in users}
        missing = [str(i) for i in manager_ids if i not in found]
        if missing:
            raise HTTPException(status_code=404, detail=f'Пользователь не найден: {", ".join(missing)}')

        bad = [u.username for u in users if u.role is not UserRole.PROJECT_MANAGER]
        if bad:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Руководителем можно назначить только пользователя с ролью «Руководитель»: {", ".join(bad)}',
            )
        inactive = [u.username for u in users if not u.is_active]
        if inactive:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Пользователь деактивирован: {", ".join(inactive)}',
            )
        return users

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