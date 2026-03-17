import asyncio
from app.db.session import AsyncSessionLocale
from app.repositories.event_repo import EventRepository
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger('tasks.cleanup')

async def event_cleanup_task() -> None:
    settings = get_settings()
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