import uuid
from datetime import datetime, timezone
from sqlalchemy import select, update, func, delete, insert, or_
from sqlalchemy.orm import aliased, selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Card, User, Attachment, CardPriority, CardStatus, Comment, card_assignees


class CardRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    def _get_base_query(self):
        Creator = aliased(User)

        return select(
            Card,
            Creator.username.label('created_by_username'),
            func.count(Comment.id).label('comments_count')
        ).join(
            Creator, Card.created_by == Creator.user_id
        ).outerjoin(
            Comment, Card.id == Comment.card_id
        ).group_by(
            Card.id, Creator.username
        ).options(
            selectinload(Card.attachments),
            selectinload(Card.assignees),
        )

    @staticmethod
    def _assignee_filter(q, viewer_id: uuid.UUID):
        """Только карточки, где viewer числится исполнителем."""
        sub = select(card_assignees.c.card_id).where(card_assignees.c.user_id == viewer_id)
        return q.where(Card.id.in_(sub))

    @staticmethod
    def _visible_filter(q, viewer_id: uuid.UUID, include_own_created: bool = False):
        """
        Ограничивает выборку тем, что viewer имеет право видеть.

        include_own_created=False (исполнитель) — только назначенные ему задачи.
        include_own_created=True  (постановщик) — назначенные ему ПЛЮС созданные им.
        Постановщик не видит чужих задач, даже созданных админом,
        пока его самого не назначили исполнителем.
        """
        sub = select(card_assignees.c.card_id).where(card_assignees.c.user_id == viewer_id)
        cond = Card.id.in_(sub)
        if include_own_created:
            cond = or_(cond, Card.created_by == viewer_id)
        return q.where(cond)

    def _map_row_to_card(self, row):
        if not row:
            return None
        card = row.Card
        card.created_by_username = row.created_by_username
        card.comments_count = row.comments_count
        return card

    #======================================================
    # Cards
    #======================================================
    async def get_all(
        self,
        column_id: uuid.UUID | None = None,
        assigned_to: uuid.UUID | None = None,
        visible_for: uuid.UUID | None = None,
        include_own_created: bool = False,
        project_ids: list[uuid.UUID] | None = None,
    ) -> list[Card]:
        q = self._get_base_query()

        if project_ids is not None:
            q = q.where(Card.project_id.in_(project_ids))
        if column_id:
            q = q.where(Card.column_id == column_id)
        if assigned_to:
            q = self._assignee_filter(q, assigned_to)
        if visible_for:
            q = self._visible_filter(q, visible_for, include_own_created)

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

    async def archive_card(self, card_id: uuid.UUID) -> bool:
        card = await self.get_by_id(card_id)
        if card:
            card.is_archived = True
            card.updated_at = datetime.now(timezone.utc)
            await self.session.flush()
            return True
        return False

    async def restore_card(self, card_id: uuid.UUID) -> bool:
        card = await self.get_by_id(card_id)
        if card:
            card.is_archived = False
            card.updated_at = datetime.now(timezone.utc)
            await self.session.flush()
            return True
        return False

    async def create(
            self,
            title: str,
            column_id: uuid.UUID,
            position: int,
            created_by: uuid.UUID,
            description: str = None,
            deadline: datetime = None,
            priority: CardPriority = CardPriority.LOW,
            status: 'CardStatus | None' = None,
            is_archived: bool = False,
            assignees: list[User] | None = None,
            project_id: uuid.UUID | None = None,
    ) -> Card:
        now = datetime.now(timezone.utc)
        card = Card(
            id=uuid.uuid4(),
            title=title,
            description=description,
            column_id=column_id,
            created_by=created_by,
            position=position,
            deadline=deadline,
            priority=priority,
            status=status or CardStatus.NOT_STARTED,
            is_archived=is_archived,
            created_at=now,
            project_id=project_id,
        )
        if assignees:
            card.assignees = list(assignees)
        self.session.add(card)
        await self.session.flush()
        return await self.get_by_id(card.id)

    async def update(self, card: Card, **kwargs) -> Card:
        for k, v in kwargs.items():
            setattr(card, k, v)
        card.updated_at = datetime.now(timezone.utc)
        await self.session.flush()
        return await self.get_by_id(card.id)

    async def delete(self, card: Card) -> None:
        await self.session.delete(card)
        await self.session.flush()

    #======================================================
    # Assignees (many-to-many)
    #======================================================
    async def get_assignee_ids(self, card_id: uuid.UUID) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(card_assignees.c.user_id).where(card_assignees.c.card_id == card_id)
        )
        return list(result.scalars().all())

    async def set_assignees(self, card: Card, user_ids: list[uuid.UUID]) -> None:
        """Полностью заменяет список исполнителей карточки."""
        card_id = card.id
        current = set(await self.get_assignee_ids(card_id))
        target = set(user_ids)

        to_remove = current - target
        to_add = target - current

        if to_remove:
            await self.session.execute(
                delete(card_assignees).where(
                    card_assignees.c.card_id == card_id,
                    card_assignees.c.user_id.in_(to_remove),
                )
            )
        if to_add:
            await self.session.execute(
                insert(card_assignees),
                [
                    {'card_id': card_id, 'user_id': uid, 'assigned_at': datetime.now(timezone.utc)}
                    for uid in to_add
                ],
            )
        await self.session.flush()

        # Связь меняется через core-запросы, поэтому ORM не знает, что
        # card.assignees устарел. Без сброса ответ вернёт прежний состав.
        if to_remove or to_add:
            self.session.expire(card, ['assignees'])

    async def is_assignee(self, card_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        result = await self.session.execute(
            select(card_assignees.c.card_id).where(
                card_assignees.c.card_id == card_id,
                card_assignees.c.user_id == user_id,
            )
        )
        return result.first() is not None

    #======================================================
    # Validate positions in Column
    #======================================================
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

    #======================================================
    # Attachments
    #======================================================
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

    #======================================================
    # Comments
    #======================================================
    async def add_comment(self, card_id: uuid.UUID, user_id: uuid.UUID, text: str) -> Comment:
        comment = Comment(
            id=uuid.uuid4(),
            card_id=card_id,
            user_id=user_id,
            text=text,
            created_at=datetime.now(timezone.utc)
        )
        self.session.add(comment)
        await self.session.flush()

        stmt = (
            select(Comment)
            .where(Comment.id == comment.id)
            .options(selectinload(Comment.author))
        )
        result = await self.session.execute(stmt)
        return result.scalar_one()

    async def edit_comment(self, comment_id: uuid.UUID, new_text: str) -> Comment:
        stmt = (
            select(Comment)
            .where(Comment.id == comment_id)
            .options(selectinload(Comment.author))
        )
        result = await self.session.execute(stmt)
        comment = result.scalar_one_or_none()

        if not comment:
            return None

        comment.text = new_text
        comment.updated_at = datetime.now(timezone.utc)

        await self.session.flush()
        await self.session.refresh(comment)

        return comment

    async def get_comments_paginated(self, card_id: uuid.UUID, last_comment_id: uuid.UUID | None = None, limit: int = 20) -> list[Comment]:
        """Метод для ленивой подгрузки комментариев"""
        q = (
            select(Comment)
            .where(Comment.card_id == card_id)
            .options(selectinload(Comment.author))
            .order_by(Comment.created_at.desc())
        )
        if last_comment_id:
            ts_query = select(Comment.created_at).where(Comment.id == last_comment_id)
            ts_result = await self.session.execute(ts_query)
            last_ts = ts_result.scalar()

            if last_ts:
                q = q.where(Comment.created_at < last_ts)

        q = q.limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get_comment_by_id(self, comment_id: uuid.UUID) -> Comment | None:
        q = select(Comment).where(Comment.id == comment_id).options(selectinload(Comment.author))
        result = await self.session.execute(q)
        return result.scalar_one_or_none()

    async def delete_comment(self, comment: Comment) -> None:
        await self.session.delete(comment)
        await self.session.flush()

    async def get_comment_count(self, card_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(Comment.id)).where(Comment.card_id == card_id)
        )
        return result.scalar() or 0
