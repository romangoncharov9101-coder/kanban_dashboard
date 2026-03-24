import uuid
from datetime import datetime, timezone
from sqlalchemy import select, update, func
from sqlalchemy.orm import aliased, selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Card, User, Attachment

class CardRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    def _get_base_query(self):
        Creator = aliased(User)
        Assignee = aliased(User)

        return select(
            Card,
            Creator.username.label('created_by_username'),
            Assignee.username.label('assigned_to_username')
        ).join(
            Creator, Card.created_by == Creator.user_id
        ).outerjoin(
            Assignee, Card.assigned_to == Assignee.user_id
        ).options(
            selectinload(Card.attachments)
        )
    
    def _map_row_to_card(self, row):
        if not row:
            return None
        card = row.Card
        card.created_by_username = row.created_by_username
        card.assigned_to_username = row.assigned_to_username
        return card

    async def get_all(self, column_id: uuid.UUID | None = None, assigned_to: uuid.UUID | None = None) -> list[Card]:
        q = self._get_base_query()
        if column_id:
            q = q.where(Card.column_id == column_id)
        if assigned_to:
            q = q.where(Card.assigned_to == assigned_to)
        q = q.order_by(Card.column_id, Card.position)
        result = await self.session.execute(q)
        return [self._map_row_to_card(row) for row in result.all()]
    
    async def get_by_id(self, card_id: uuid.UUID) -> Card | None:
        q = self._get_base_query().where(Card.id == card_id)
        result = await self.session.execute(q)
        row = result.first()
        return self._map_row_to_card(row)
    
    async def get_by_column_ordered(self, column_id: uuid.UUID) -> list[Card]:
        q = self._get_base_query().where(Card.column_id == column_id).order_by(Card.position)
        result = await self.session.execute(q)
        return [self._map_row_to_card(row) for row in result.all()]
    
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
            assigned_to: uuid.UUID = None,
            deadline: datetime = None
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
            deadline=deadline,
            created_at=now
        )
        self.session.add(card)
        await self.session.flush()
        return await self.get_by_id(card.id)
    
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

    async def get_attachment_by_id(self, attachment_id: uuid.UUID) -> Attachment:
        q = select(Attachment).where(Attachment.id == attachment_id)
        result = await self.session.execute(q)
        return result.scalar_one_or_none()

    async def get_attachment_count(self, card_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(Attachment.id)).where(Attachment.card_id == card_id)
        )
        return result.scalar() or 0
    
    async def add_attachment(self, attachment_data: dict) -> Attachment:
        db_attachment = Attachment(**attachment_data)
        self.session.add(db_attachment)
        await self.session.flush()
        return db_attachment
    
    async def delete_attachment(self, attachment_id: uuid.UUID):
        result = await self.session.execute(
            select(Attachment).where(Attachment.id == attachment_id)
        )
        attachment = result.scalar_one_or_none()
        if attachment:
            await self.session.delete(attachment)

