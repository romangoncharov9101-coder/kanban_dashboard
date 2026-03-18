import uuid
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import Session
from app.core.config import get_settings

settings = get_settings()

class SessionRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, user_id: uuid.UUID) -> Session:
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=settings.SESSION_TTL_SECONDS)
        db_session = Session(
            id=uuid.uuid4(),
            user_id=user_id,
            created_at=now,
            expires_at=expires,
        )
        self.session.add(db_session)
        await self.session.flush()
        await self.session.refresh(db_session)
        return db_session
    
    async def get_valid(self, session_id: uuid.UUID) -> Session | None:
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(Session)
            .options(selectinload(Session.user))
            .where(Session.id == session_id)
            .where(Session.expires_at > now)
        )
        return result.scalar_one_or_none()
    
    async def delete(self, session_id: uuid.UUID) -> None:
        await self.session.execute(
            delete(Session).where(Session.id == session_id)
        )
        await self.session.flush()

    async def delete_for_user(self, user_id: uuid.UUID) -> None:
        await self.session.execute(
            delete(Session).where(Session.user_id == user_id)
        )
        await self.session.flush()

    async def delete_expired(self) -> int:
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            delete(Session).where(Session.expires_at <= now)
        )
        await self.session.flush()
        return result.rowcount