from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.event_repo import EventRepository
from app.db.schemas import EventOut

class EventService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = EventRepository(session)

    async def get_recent(self, limit: int = 50) ->  list[EventOut]:
        events = await self.repo.get_recent(limit=limit)
        return [EventOut.model_validate(e) for e in events]
        