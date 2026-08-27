import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from app.manager import manager
from app.core.logging import get_logger
from app.core.deps import get_current_user_ws
from app.db.session import AsyncSessionLocale
from app.repositories.user_repo import UserRepository

logger  = get_logger('websocket.router')
router = APIRouter()

@router.websocket('/ws')
async def websocke_enpoint(
    ws: WebSocket,
    user_id: str | None = Query(default=None),
):
    user = await get_current_user_ws(ws)
    await manager.connect(ws)

    if user:
        manager.bind_user(str(user.user_id), ws, role=user.role.value)
        async with AsyncSessionLocale() as session:
            try:
                repo = UserRepository(session)
                u = await repo.get_user_by_id(user.user_id)
                if u:
                    await repo.set_online(u, True)
                    await session.commit()
                    await manager.publish(
                        'user_online',
                        str(u.user_id),
                        {'user_id': str(u.user_id), 'username': u.username},
                    )
            except Exception as exc:
                logger.warning(f'Could not set user online: {exc}')

    sender_task = asyncio.create_task(manager.sender_loop(ws))

    try:
        while True:
            raw = await ws.receive_text()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get('event') == 'card_dragging' and user:
                await manager.publish(
                    'card_dragging',
                    msg.get('card_id'),
                    {
                        'card_id': msg.get('card_id'),
                        'dragged_by': str(user.user_id),
                        'username': user.username,
                        'source_column_id': msg.get('source_column_id'),
                        'current_column_id': msg.get('current_column_id'),
                        'current_position': msg.get('current_position', 0),
                    }
                )
    except WebSocketDisconnect:
        logger.info(f'WS disconnected (user={user.username if user else "anon"})',)
    except Exception as exc:
        logger.warning(f'WS error: {exc}')
    finally:
        manager.disconnect(ws)
        sender_task.cancel()
        try:
            await sender_task
        except asyncio.CancelledError:
            pass

        if user:
            async with AsyncSessionLocale() as session:
                try:
                    repo = UserRepository(session)
                    u = await repo.get_user_by_id(user.user_id)
                    if u:
                        await repo.set_online(u, False)
                        await session.commit()
                        await manager.publish(
                            'user_offline',
                            str(u.user_id),
                            {'user_id': str(u.user_id), 'username': u.username}
                        )
                except Exception as exc:
                    logger.warning(f'Could not set user offline: {exc}')
