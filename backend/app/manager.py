import asyncio
import json
from datetime import datetime, timezone
from fastapi import WebSocket
from app.core.logging import get_logger

logger = get_logger('wbsocket.manager')

class ConnectionManager:
    def __init__(self):
        self._connections: dict[WebSocket, asyncio.Queue] = {}
        self._user_to_ws: dict[str, WebSocket] = {}
        self.broadcast_queue: asyncio.Queue = asyncio.Queue()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections[ws] = asyncio.Queue()
        logger.info(f'WS connected - active connections: {len(self._connections)}')

    def bind_user(self, user_id: str, ws: WebSocket):
        self._user_to_ws[str(user_id)] = ws
        logger.info(f'User {user_id} bound to websocket')

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
            q = self._connections[ws]
            data = json.dumps(message, default=str)
            await q.put(data)
            return True
        return False

    async def broadcast(self, message: dict) -> None:
        data = json.dumps(message, default=str)
        for ws, q  in list(self._connections.items()):
            await q.put(data)

    async def sender_loop(self, ws: WebSocket) -> None:
        q = self._connections.get(ws)
        if q is None:
            return
        try:
            while True:
                data = await q.get()
                if data is None:
                    break
                await ws.send_text(data)
        except Exception as exc:
            logger.warning(f'WS sender error: {exc}')

    async def broadcast_loop(self) -> None:
        logger.info('Broadcast loop started')
        while True:
            message = await self.broadcast_queue.get()
            await self.broadcast(message)

    async def publish(self, event: str, entity_id: str | None, payload: str) -> None:
        msg = {
            'event': event,
            'entity_id': entity_id,
            'payload':  payload,
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }
        await self.broadcast_queue.put(msg)

manager = ConnectionManager()