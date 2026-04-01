from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.event_repo import EventRepository
from app.db.schemas import EventOut, EventType
from app.db.models import User
import uuid

class EventService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = EventRepository(session)

    async def log_event(self, event_type: EventType, message: str, card_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None, payload: dict | None = None) -> EventOut:
        event = self.repo.create(
            event_type=event_type,
            message=message,
            card_id=card_id,
            user_id=user_id,
            payload=payload or {}
        )
        return EventOut.model_validate(event)
    
    async def get_card_history(self, card_id: uuid.UUID, limit: int = 20, last_id: uuid.UUID | None = None) -> list[EventOut]:
        events = await self.repo.get_by_card(card_id, limit=limit, last_id=last_id)
        return [EventOut.model_validate(e) for e in events]
    
    async def get_recent_global(self, limit: int = 50) -> list[EventOut]:
        events = await self.repo.get_recent(limit=limit)
        return [EventOut.model_validate(e) for e in events]
    
    async def cleanup_old_events(self, days: int = 30):
        seconds = days * 24 * 3600
        return self.repo.delete_older_than(seconds)
        