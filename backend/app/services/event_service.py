import uuid
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Event, User, card_assignees
from app.db.schemas import EventOut, EventType
from app.repositories.card_repo import CardRepository
from app.repositories.event_repo import EventRepository


class EventService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = EventRepository(session)
        self.card_repo = CardRepository(session)

    async def log_event(self, event_type: EventType, message: str, card_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None, payload: dict | None = None) -> EventOut:
        event = await self.repo.create(
            event_type=event_type,
            message=message,
            card_id=card_id,
            user_id=user_id,
            payload=payload or {}
        )
        return EventOut.model_validate(event)

    async def get_card_history(self, card_id: uuid.UUID, viewer: User, limit: int = 20, last_id: uuid.UUID | None = None) -> list[EventOut]:
        card = await self.card_repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        if not viewer.is_manager and not card.is_assignee(viewer.user_id):
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

        events = await self.repo.get_by_card(card_id, limit=limit, last_id=last_id)
        return [EventOut.model_validate(e) for e in events]

    async def get_recent_global(self, viewer: User, limit: int = 50) -> list[EventOut]:
        """
        Менеджеры видят всю ленту. Обычный пользователь — только события
        по своим карточкам, иначе через историю утекали бы чужие задачи.
        """
        if viewer.is_manager:
            events = await self.repo.get_recent(limit=limit)
            return [EventOut.model_validate(e) for e in events]

        visible_cards = select(card_assignees.c.card_id).where(
            card_assignees.c.user_id == viewer.user_id
        )
        result = await self.session.execute(
            select(Event)
            .where(Event.card_id.in_(visible_cards))
            .options(selectinload(Event.user))
            .order_by(Event.created_at.desc())
            .limit(limit)
        )
        return [EventOut.model_validate(e) for e in result.scalars().all()]

    async def cleanup_old_events(self, days: int = 30):
        seconds = days * 24 * 3600
        return await self.repo.delete_older_than(seconds)
