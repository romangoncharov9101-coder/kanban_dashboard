import asyncio
from app.db.session import AsyncSessionLocale
from app.repositories.event_repo import EventRepository
from app.repositories.session_repo import SessionRepository
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger('tasks.cleanup')
settings = get_settings()

async def event_cleanup_task() -> None:
    logger.info(
        f'Event cleanup task started (interval={settings.EVENT_CLEANUP_INTERVAL}, max_age={settings.EVENT_MAX_AGE_SECONDS})',
    )
    while True:
        await asyncio.sleep(settings.EVENT_CLEANUP_INTERVAL)
        try:
            async with AsyncSessionLocale() as session:
                repo = EventRepository(session)
                deleted = await repo.delete_older_than(settings.EVENT_MAX_AGE_SECONDS)
                await session.commit()
                if deleted:
                    logger.info(f'Event cleanup: removed {deleted} old events')

        except Exception as exc:
            logger.error(f'Event cleanup error: {exc}', exc_info=True)

async def session_cleanup_task() -> None:
    logger.info(f'Session cleanup task started (interval={settings.EVENT_CLEANUP_INTERVAL}s)')
    while True:
        await asyncio.sleep(settings.EVENT_CLEANUP_INTERVAL)
        try:
            async with AsyncSessionLocale() as session:
                repo = SessionRepository(session)
                deleted = await repo.delete_expired()
                await session.commit()
                if deleted:
                    logger.info(f'Session cleanup: removed {deleted} expired sessions')
        except Exception as exc:
            logger.error(f'Session cleanup error: {exc}')