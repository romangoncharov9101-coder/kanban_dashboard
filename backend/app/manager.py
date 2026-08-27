import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fastapi import WebSocket
from typing import Any, Iterable
from app.core.logging import get_logger

logger = get_logger('wbsocket.manager')

# Роли, которые видят всю доску целиком.
PRIVILEGED_ROLES = {'ADMIN', 'TEAM_LEAD'}


@dataclass
class Connection:
    queue: asyncio.Queue
    user_id: str | None = None
    role: str | None = None

    @property
    def is_privileged(self) -> bool:
        return self.role in PRIVILEGED_ROLES


class ConnectionManager:
    """
    Держит открытые сокеты и рассылает события.

    Ключевое отличие от прошлой версии: у сообщения есть аудитория.
    Пользователь с ролью USER видит только назначенные ему задачи,
    поэтому карточные события ему отправляются, только если он
    входит в список исполнителей. Иначе фильтрация в REST не имела бы
    смысла — чужие карточки приезжали бы по WebSocket.
    """

    def __init__(self):
        self._connections: dict[WebSocket, Connection] = {}
        self._user_to_ws: dict[str, WebSocket] = {}
        self.broadcast_queue: asyncio.Queue = asyncio.Queue()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections[ws] = Connection(queue=asyncio.Queue())
        logger.info(f'WS connected - active connections: {len(self._connections)}')

    def bind_user(self, user_id: str, ws: WebSocket, role: str | None = None):
        self._user_to_ws[str(user_id)] = ws
        conn = self._connections.get(ws)
        if conn:
            conn.user_id = str(user_id)
            conn.role = role
        logger.info(f'User {user_id} ({role}) bound to websocket')

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.pop(ws, None)
        user_to_remove = None
        for uid, socket in self._user_to_ws.items():
            if socket == ws:
                user_to_remove = uid
                break
        if user_to_remove:
            self._user_to_ws.pop(user_to_remove)
        logger.info(f'WS disconnected — active connections: {len(self._connections)}')

    async def send_personal_message(self, user_id, message: dict):
        ws = self._user_to_ws.get(str(user_id))
        if ws and ws in self._connections:
            data = json.dumps(message, default=str)
            await self._connections[ws].queue.put(data)
            return True
        return False

    def _should_receive(self, conn: Connection, audience: set[str] | None, include_privileged: bool) -> bool:
        if audience is None:
            return True
        if conn.user_id is None:
            return False
        if include_privileged and conn.is_privileged:
            return True
        return conn.user_id in audience

    async def broadcast(
        self,
        message: dict,
        audience: set[str] | None = None,
        include_privileged: bool = True,
    ) -> None:
        data = json.dumps(message, default=str)
        for _, conn in list(self._connections.items()):
            if self._should_receive(conn, audience, include_privileged):
                await conn.queue.put(data)

    async def sender_loop(self, ws: WebSocket) -> None:
        conn = self._connections.get(ws)
        if conn is None:
            return
        try:
            while True:
                data = await conn.queue.get()
                if data is None:
                    break
                await ws.send_text(data)
        except Exception as exc:
            logger.warning(f'WS sender error: {exc}')

    async def broadcast_loop(self) -> None:
        logger.info('Broadcast loop started')
        while True:
            item = await self.broadcast_queue.get()
            message, audience, include_privileged = item
            await self.broadcast(message, audience, include_privileged)

    async def publish(
        self,
        event: str,
        entity_id: str | None,
        payload: Any,
        audience: Iterable[str] | None = None,
        include_privileged: bool = True,
    ) -> None:
        """
        audience=None  → событие видят все подключённые.
        audience={...} → событие видят перечисленные user_id,
                         плюс все ADMIN/TEAM_LEAD (если include_privileged).
        """
        msg = {
            'event': event,
            'entity_id': entity_id,
            'payload':  payload,
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }
        aud = {str(u) for u in audience} if audience is not None else None
        await self.broadcast_queue.put((msg, aud, include_privileged))


manager = ConnectionManager()
