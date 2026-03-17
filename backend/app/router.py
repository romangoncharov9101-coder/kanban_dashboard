import uuid
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from app.manager import manager
from app.core.logging import get_logger
from app.db.session import AsyncSessionLocale
from app.repositories.user_repo import UserRepository

logger  = get_logger('websocket.router')
router = APIRouter()

@router.websocket('/ws')
async def websocke_enpoint(
    ws:WebSocket,
    user_id: str | None = Query(default=None),
):
    await manager.connect(ws)
    user = None

    if user_id:
        async with AsyncSessionLocale() as session:
            try: 
                repo = UserRepository(session)
                user = await repo.get_user_by_id(uuid.UUID(user_id))
                if user:
                    await repo.set_online(user, True)
                    await session.commit()
                    await manager.publish(
                        'user_online',
                        str(user.user_id),
                        {'user_id': str(user.user_id), 'username': user.username},
                    )
            except Exception as exc:
                logger.warning(f'Could not set user onlime: {exc}', exc)

    sender_task = asyncio.create_task(manager.sender_loop(ws))

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        logger.info(f'WebSocket client disconnected (user_id={user_id})')
    except Exception as exc:
        logger.warning(f'WebSocket error: {exc}')
    finally:
        manager.disconnect(ws)
        sender_task.cancel()
        try:
            await sender_task
        except asyncio.CancelledError:
            pass

        if user_id:
            async with AsyncSessionLocale() as session:
                try:
                    repo = UserRepository(session)
                    u = await repo.get_user_by_id(uuid.UUID(user_id))
                    if u:
                        await repo.set_online(u, False)
                        await session.commit()
                        await manager.publish(
                            'user_offline',
                            str(u.user_id),
                            {'user_id': str(u.user_id), 'username': u.username}
                        )
                except Exception as exc:
                    logger.warning(f'Could not set user ofline: {exc}')