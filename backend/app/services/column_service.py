import uuid
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import User
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.repositories.project_repo import ProjectRepository
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

    async def get_all(self, project_id=None) -> list[ColumnOut]:
        cols = await self.repo.get_all(project_id)
        return [ColumnOut.model_validate(c) for c in cols]

    async def get_for_projects(self, project_ids: list) -> list[ColumnOut]:
        cols = await self.repo.get_for_projects(project_ids)
        return [ColumnOut.model_validate(c) for c in cols]

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
        )
        out = ColumnOut.model_validate(col)
        payload = out.model_dump(mode='json')

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

        await manager.publish('column_deleted', str(column_id), payload)
        await self.session.commit()
