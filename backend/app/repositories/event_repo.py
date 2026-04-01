import uuid
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Event, EventType

class EventRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, event_type: EventType, message: str, card_id: uuid.UUID | None = None, user_id: uuid.UUID = None, payload: dict = None) -> Event:
        ev = Event(
            id=uuid.uuid4(),
            event_type=event_type,
            message=message,
            card_id=card_id,
            user_id=user_id,
            payload=payload or {},
            created_at=datetime.now(timezone.utc)
        )
        self.session.add(ev)
        await self.session.flush()
        return ev
    
    async def get_by_card(self, card_id: uuid.UUID, limit: int = 20, last_id: uuid.UUID | None = None) -> list[Event]:
        query = (
            select(Event)
            .where(Event.card_id == card_id)
            .options(selectinload(Event.user))
            .order_by(Event.created_at.desc())
        )
        if last_id:
            last_event_query = select(Event.created_at).where(Event.id == last_id)
            last_event_res = await self.session.execute(last_event_query)
            last_created_at = last_event_res.scalar()

            if last_created_at:
                query = query.where(Event.created_at < last_created_at)

        query = query.limit(limit)

        result = await self.session.execute(query)
        return list(result.scalars().all())
    
    async def get_recent(self, limit: int = 50) -> list[Event]:
        result = await self.session.execute(
            select(Event).order_by(Event.created_at.desc()).limit(limit)
        )

        return list(result.scalars().all())
    
    async def delete(self, event: Event) -> None:
        await self.session.delete(event)
        await self.session.flush()

    async def delete_older_than(self, max_age_seconds: int) -> int:
        cutoof = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
        result = await self.session.execute(
            delete(Event).where(Event.created_at < cutoof)
        )
        await self.session.flush()
        return result.rowcount