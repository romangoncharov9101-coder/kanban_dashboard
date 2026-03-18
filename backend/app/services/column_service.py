import uuid
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.db.schemas import ColumnCreate, ColumnUpdate, ColumnOut
from app.manager import manager
from app.core.logging import get_logger
import json

logger = get_logger('services.column')

class ColumnService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)

    async def get_all(self) -> list[ColumnOut]:
        cols = await self.repo.get_all()
        return [ColumnOut.model_validate(c) for c in cols]
    
    async def create(self, data: ColumnCreate) -> ColumnOut:
        max_pos = await self.repo.get_max_position()
        col = await self.repo.create(name=data.name, position=max_pos + 1)
        out = ColumnOut.model_validate(col)
        payload = out.model_dump(mode='json')

        # json_compatible_payload = json.loads(payload.model_dump_json())
        await self.event_repo.create('column_created', payload, str(col.id))
        await manager.publish('column_created', str(col.id), payload)
        logger.info(f'Column created: {col.id, col.name}')
        return out
    
    async def update(self, column_id: uuid.UUID, data: ColumnUpdate) -> ColumnOut:
        col = await self.repo.get_by_id(column_id)
        if not col:
            raise HTTPException(status_code=404, detail='Column not found')
        
        updates: dict = {}
        if data.name is None:
            updates['name'] = data.name

        if data.position is not None and data.position != col.position:
            old_pos = col.position
            new_pos = data.position
            all_cols = await self.repo.get_all()
            max_pos = len(all_cols) - 1
            new_pos = min(new_pos, max_pos)

            if new_pos < old_pos:
                for c in all_cols:
                    if c.id != col.id and new_pos <= c.position < old_pos:
                        c.position += 1

            else:
                for c in all_cols:
                    if c.id != col.id and old_pos < c.position <= new_pos:
                        c.position -= 1

            await self.session.flush()
            updates['position'] = new_pos
        
        col = await self.repo.update(col, **updates)
        out = ColumnOut.model_validate(col)
        payload = out.model_dump(mode='json')
        await self.event_repo.create('column_update', payload, str(col.id))
        await manager.publish('column_updated', str(col.id), payload)
        logger.info(f'Column updated: {col.id}')
        return out
    
    async def delete(self, column_id: uuid.UUID) -> None:
        col = await self.repo.get_by_id(column_id)
        if not col:
            raise HTTPException(status_code=404, detail="Column not found")
        
        card_count = await self.repo.count_card_in_column(column_id)
        if card_count > 0:
            raise HTTPException(
                status_code=409,
                detail="Cannot delete column with cards. Move or delete cards first.",
            )
        
        await self.repo.delete(col)
        await self.repo.normalize_positions()
        payload = {'id': str(column_id)}
        await self.event_repo.create('column_deleted', payload, str(column_id))
        await manager.publish('column_deleted', str(column_id), payload)
        logger.info(f'Column deleted: {column_id}')