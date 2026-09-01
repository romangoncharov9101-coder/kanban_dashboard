import uuid
from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Column, Card, card_assignees

class ColumnRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_all(self, project_id: uuid.UUID | None = None) -> list[Column]:
        q = select(Column).order_by(Column.position)
        if project_id is not None:
            q = q.where(Column.project_id == project_id)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get_for_projects(self, project_ids: list[uuid.UUID]) -> list[Column]:
        if not project_ids:
            return []
        result = await self.session.execute(
            select(Column).where(Column.project_id.in_(project_ids)).order_by(Column.position)
        )
        return list(result.scalars().all())
    
    async def get_creatable_ids_with_assignment(
        self, column_ids: list[uuid.UUID], user_id: uuid.UUID
    ) -> set[uuid.UUID]:
        """
        Из переданных личных категорий — те, где у пользователя уже есть
        назначенная задача. Используется, чтобы скрыть пустую личную
        категорию от исполнителя, пока в ней нет его задачи.
        """
        if not column_ids:
            return set()
        result = await self.session.execute(
            select(Card.column_id)
            .join(card_assignees, card_assignees.c.card_id == Card.id)
            .where(Card.column_id.in_(column_ids), card_assignees.c.user_id == user_id)
            .distinct()
        )
        return set(result.scalars().all())

    async def get_by_id(self, column_id: uuid.UUID) -> Column | None:
        result = await self.session.execute(
            select(Column).where(Column.id == column_id)
        )
        return result.scalar_one_or_none()
    
    async def get_max_position(self, project_id: uuid.UUID | None = None) -> int:
        q = select(func.max(Column.position))
        if project_id is not None:
            q = q.where(Column.project_id == project_id)
        result = await self.session.execute(q)
        val = result.scalar_one_or_none()
        return val if val is not None else -1
    
    async def count_card_in_column(self, column_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count()).select_from(Card).where(Card.column_id == column_id)
        )
        return result.scalar_one()
    
    async def create(self, name: str, position: int, project_id: uuid.UUID,
                     is_user_movable: bool = False, is_user_creatable: bool = False) -> Column:
        col = Column(id=uuid.uuid4(), name=name, position=position,
                     project_id=project_id, is_user_movable=is_user_movable,
                     is_user_creatable=is_user_creatable)
        self.session.add(col)
        await self.session.flush()
        await self.session.refresh(col)
        return col

    async def update(self, column: Column, **kwargs) -> Column:
        # Явно присваиваем всё, что пришло: сервис передаёт только
        # реально изменившиеся поля, а False — валидное значение
        # (например is_user_movable=False).
        for k, v in kwargs.items():
            setattr(column, k, v)
        await self.session.flush()
        await self.session.refresh(column)
        return column
    
    async def delete(self, column: Column) -> None:
        await self.session.delete(column)
        await self.session.flush()

    async def shift_position_after(self, position: int, delta: int) -> None:
        await self.session.execute(
            update(Column)
            .where(Column.position >= position)
            .values(position=Column.position + delta)
        )

    async def normalize_positions(self, project_id: uuid.UUID | None = None) -> None:
        cols = await self.get_all(project_id)
        for idx, col in enumerate(cols):
            if col.position != idx:
                col.position = idx
        await self.session.flush()