import uuid
from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Column, Card

class ColumnRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_all(self) -> list[Column]:
        result = await self.session.execute(
            select(Column).order_by(Column.position)
        )
        return list(result.scalars().all())
    
    async def get_by_id(self, column_id: uuid.UUID) -> Column | None:
        result = await self.session.execute(
            select(Column).where(Column.id == column_id)
        )
        return result.scalar_one_or_none()
    
    async def get_max_position(self) -> int:
        result = await self.session.execute(
            select(func.max(Column.position))
        )
        val = result.scalar_one_or_none()
        return val if val is not None else -1
    
    async def count_card_in_column(self, column_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count()).select_from(Card).where(Card.column_id == column_id)
        )
        return result.scalar_one()
    
    async def create(self, name: str, position: int) -> Column:
        col = Column(id=uuid.uuid4(), name=name, position=position)
        self.session.add(col)
        await self.session.flush()
        await self.session.refresh(col)
        return col

    async def update(self, column: Column, **kwargs) -> Column:
        for k, v in kwargs.items():
            if v is not None:
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

    async def normalize_positions(self) -> None:
        cols = await self.get_all()
        for idx, col in enumerate(cols):
            if col.position != idx:
                col.position = idx
        await self.session.flush()