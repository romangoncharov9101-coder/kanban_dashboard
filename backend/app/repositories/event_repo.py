import uuid
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Event

class EventRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, event: str, payload: dict, entity_id: str | None = None) -> Event:
        ev = Event(
            id=uuid.uuid4(),
            event=event,
            entity_id=entity_id,
            payload=payload,
            created_at=datetime.now(timezone.utc)
        )
        self.session.add(ev)
        await self.session.flush()
        await self.session.refresh(ev)
        return ev
    
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