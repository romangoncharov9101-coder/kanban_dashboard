import uuid
from datetime import datetime, timezone
from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Card

class CardRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_all(self, column_id: uuid.UUID | None = None, assigned_to: uuid.UUID | None = None) -> list[Card]:
        q = select(Card)
        if column_id:
            q = q.where(Card.column_id == column_id)
        if assigned_to:
            q = q.where(Card.assigned_to == assigned_to)
        q.order_by(Card.column_id, Card.position)
        result = await self.session.execute(q)
        return list(result.scalars().all())
    
    async def get_by_id(self, card_id: uuid.UUID) -> Card | None:
        result = await self.session.execute(
            select(Card).where(Card.id == card_id)
        )
        return result.scalar_one_or_none()
    
    async def get_by_column_ordered(self, column_id: uuid.UUID) -> list[Card]:
        result = await self.session.execute(
            select(Card).where(Card.column_id == column_id).order_by(Card.position)
        )
        return list(result.scalars().all())
    
    async def get_max_position_in_column(self, column_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.max(Card.position)).where(Card.column_id == column_id)
        )
        val = result.scalar_one_or_none()
        return val if val is not None else -1
    
    async def create(
            self,
            title: str,
            column_id: uuid.UUID,
            position: int,
            created_by: uuid.UUID,
            description: str = None,
            assigned_to: uuid.UUID = None
    ) -> Card:
        now = datetime.now(timezone.utc)
        card = Card(
            id=uuid.uuid4(),
            title=title,
            description=description,
            column_id=column_id,
            assigned_to=assigned_to,
            created_by=created_by,
            position=position,
            created_at=now
        )
        self.session.add(card)
        await self.session.flush()
        await self.session.refresh(card)
        return card
    
    async def update(self, card: Card, **kwargs) -> Card:
        for k, v in kwargs.items():
            setattr(card, k, v)
        card.updated_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self.session.refresh(card)
        return card
    
    async def delete(self, card: Card) -> None:
        await self.session.delete(card)
        await self.session.flush()

    async def normalize_position_in_column(self, column_id: uuid.UUID) -> None:
        cards = await self.get_by_column_ordered(column_id)
        for idx, card in enumerate(cards):
            if card.position != idx:
                card.position = idx
        await self.session.flush()

    async def insert_at_position(self, column_id: uuid.UUID, position: int) -> None:
        await self.session.execute(
            update(Card)
            .where(Card.column_id == column_id, Card.position == position)
            .values(position=Card.position + 1)
        )

    
