import uuid
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import User
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.repositories.project_repo import ProjectRepository
from app.db.models import EventType, UserRole
from app.db.schemas import ColumnCreate, ColumnUpdate, ColumnOut
from app.manager import manager
from app.core.logging import get_logger

logger = get_logger('services.column')


class ColumnService:
    """Категории доски. Создавать и менять их может только ADMIN/TEAM_LEAD."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)
        self.project_repo = ProjectRepository(session)

    async def get_all(self, project_id=None, viewer: User | None = None) -> list[ColumnOut]:
        cols = await self.repo.get_all(project_id)
        cols = await self._visible_for(cols, viewer)
        return [ColumnOut.model_validate(c) for c in cols]

    async def _visible_for(self, cols: list, viewer: User | None) -> list:
        """
        Какие категории проекта показывать зрителю.

        Кто работает в проекте — админ, постановщик проекта и ответственный
        исполнитель — видят все категории, включая открытые под личные
        задачи и пока пустые. Иначе ответственному некуда положить свою
        задачу: пустая категория просто исчезала бы с доски.

        Ответственность наследуется только вниз, от проекта к подпроектам.
        Ответственный за подпроект в родительском проекте посторонний:
        там ему видны лишь категории, где у него есть своя задача.
        Родитель при этом остаётся в меню — иначе подпроект висел бы
        в дереве без корня.
        """
        if viewer is None or viewer.role is UserRole.ADMIN:
            return cols
        if not cols:
            return cols

        from app.services.project_service import ProjectService
        project_service = ProjectService(self.session)

        by_project: dict = {}
        for c in cols:
            by_project.setdefault(c.project_id, []).append(c)

        visible: list = []
        foreign_ids: list = []

        for project_id, project_cols in by_project.items():
            project = await project_service.repo.get_by_id(project_id)
            works_here = bool(project) and (
                await project_service.can_manage_project(project, viewer)
                or await project_service.is_project_member(project, viewer)
            )
            if works_here:
                visible.extend(project_cols)
            else:
                foreign_ids.extend(c.id for c in project_cols)

        if foreign_ids:
            with_cards = await self.repo.get_column_ids_with_user_cards(
                foreign_ids, viewer.user_id
            )
            visible.extend(c for c in cols if c.id in with_cards)

        # Порядок задаёт позиция колонки, а не порядок обхода проектов
        visible.sort(key=lambda c: (c.position, c.name))
        return visible

    async def get_for_projects(self, project_ids: list) -> list[ColumnOut]:
        cols = await self.repo.get_for_projects(project_ids)
        return [ColumnOut.model_validate(c) for c in cols]

    async def search(self, query: str, viewer: User) -> list[ColumnOut]:
        """Поиск категории по номеру или по названию, в пределах видимого зрителю."""
        q = (query or '').strip()
        if not q:
            return []

        all_columns = await self.get_all(project_id=None, viewer=viewer)

        q_lower = q.lower()
        # Пользователь видит номера с префиксом C (C7), поэтому поиск
        # должен понимать и его, и голое число.
        number_part = q_lower[1:] if q_lower.startswith('c') else q_lower
        by_number = number_part if number_part.isdigit() else None

        matched = [
            c for c in all_columns
            if (by_number is not None and str(c.number) == by_number)
            or q_lower in c.name.lower()
        ]
        matched.sort(key=lambda c: (by_number is None or str(c.number) != by_number, c.number))
        return matched[:30]

    async def create(self, data: ColumnCreate, actor: User) -> ColumnOut:
        # Право вести доску проекта проверяется здесь: постановщик
        # создаёт колонки только в своих проектах.
        from app.services.project_service import ProjectService
        await ProjectService(self.session).assert_can_manage(data.project_id, actor)

        max_pos = await self.repo.get_max_position(data.project_id)
        col = await self.repo.create(
            name=data.name,
            position=max_pos + 1,
            project_id=data.project_id,
            is_user_movable=data.is_user_movable,
            is_user_creatable=data.is_user_creatable,
        )
        out = ColumnOut.model_validate(col)
        payload = out.model_dump(mode='json')

        project = await self.project_repo.get_by_id(data.project_id)
        access = 'открыта для исполнителей' if data.is_user_movable else 'закрыта для исполнителей'
        await self.event_repo.create(
            event_type=EventType.COLUMN_CREATED,
            message=f'Создал категорию «{col.name}» в проекте «{project.name if project else "—"}» ({access})',
            actor=actor,
            column_name=col.name,
            project_id=data.project_id,
            project_name=project.name if project else None,
            payload=payload,
        )

        # Структура доски одинакова для всех ролей — рассылаем всем.
        await manager.publish('column_created', str(col.id), payload)
        await self.session.commit()
        logger.info(f'Column created: {col.id, col.name}')
        return out

    async def update(self, column_id: uuid.UUID, data: ColumnUpdate, actor: User) -> ColumnOut:
        col = await self.repo.get_by_id(column_id)
        if not col:
            raise HTTPException(status_code=404, detail='Категория не найдена.')

        from app.services.project_service import ProjectService
        await ProjectService(self.session).assert_can_manage(col.project_id, actor)

        updates: dict = {}

        if data.name is not None and data.name != col.name:
            updates['name'] = data.name

        if data.is_user_movable is not None and data.is_user_movable != col.is_user_movable:
            updates['is_user_movable'] = data.is_user_movable

        if data.is_user_creatable is not None and data.is_user_creatable != col.is_user_creatable:
            # Личные задачи не видны постановщику проекта, поэтому
            # открывать эту дверь может только администратор.
            if actor.role is not UserRole.ADMIN:
                raise HTTPException(
                    status_code=403,
                    detail='Разрешать личные задачи в категории может только администратор.',
                )
            updates['is_user_creatable'] = data.is_user_creatable

        if data.position is not None and data.position != col.position:
            old_pos = col.position
            all_cols = await self.repo.get_all(col.project_id)
            max_pos = len(all_cols) - 1
            new_pos = min(data.position, max_pos)

            if new_pos != old_pos:
                if new_pos < old_pos:
                    for c in all_cols:
                        if c.id != col.id and new_pos <= c.position < old_pos:
                            c.position += 1
                else:
                    for c in all_cols:
                        if c.id != col.id and old_pos < c.position <= new_pos:
                            c.position -= 1

                await self.session.flush()
                updates['position'] = new_pos

        if not updates:
            return ColumnOut.model_validate(col)

        col = await self.repo.update(col, **updates)
        out = ColumnOut.model_validate(col)
        payload = out.model_dump(mode='json')

        project = await self.project_repo.get_by_id(col.project_id)
        changes = []
        if 'name' in updates:
            changes.append(f'переименовал в «{updates["name"]}»')
        if 'is_user_movable' in updates:
            changes.append('открыл для переноса исполнителями' if updates['is_user_movable']
                           else 'закрыл перенос исполнителями')
        if 'is_user_creatable' in updates:
            changes.append('разрешил личные задачи исполнителей' if updates['is_user_creatable']
                           else 'запретил личные задачи исполнителей')
        if 'position' in updates:
            changes.append('изменил порядок')

        await self.event_repo.create(
            event_type=EventType.COLUMN_UPDATED,
            message=f'Категория «{col.name}» в проекте «{project.name if project else "—"}»: '
                    + ', '.join(changes),
            actor=actor,
            column_name=col.name,
            project_id=col.project_id,
            project_name=project.name if project else None,
            payload=payload,
        )

        await manager.publish('column_updated', str(col.id), payload)
        await self.session.commit()
        return out

    async def delete(self, column_id: uuid.UUID, actor: User) -> None:
        col = await self.repo.get_by_id(column_id)
        if not col:
            raise HTTPException(status_code=404, detail="Категория не найдена.")

        from app.services.project_service import ProjectService
        await ProjectService(self.session).assert_can_manage(col.project_id, actor)

        card_count = await self.repo.count_card_in_column(column_id)
        if card_count > 0:
            raise HTTPException(
                status_code=409,
                detail="Невозможно удалить категорию с карточками. Переместите или удалите карточки сначала. Проверьте, может у категории есть карточки скрытые фильтрами.",
            )

        col_name = col.name
        project_id = col.project_id
        await self.repo.delete(col)
        await self.repo.normalize_positions(project_id)

        payload = {'id': str(column_id), 'name': col_name}

        project = await self.project_repo.get_by_id(project_id)
        await self.event_repo.create(
            event_type=EventType.COLUMN_DELETED,
            message=f'Удалил категорию «{col_name}» из проекта «{project.name if project else "—"}»',
            actor=actor,
            column_name=col_name,
            project_id=project_id,
            project_name=project.name if project else None,
            payload=payload,
        )

        await manager.publish('column_deleted', str(column_id), payload)
        await self.session.commit()