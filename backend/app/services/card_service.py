import uuid
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.card_repo import CardRepository
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.repositories.user_repo import UserRepository
from app.db.schemas import CardCreate, CardUpdate, CardMoveRequest, CardOut
from app.manager import manager
from app.core.logging import get_logger
from datetime import datetime, timezone

logger = get_logger('services.card')

class CardService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = CardRepository(session)
        self.column_repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)
        self.user_repo = UserRepository(session)

    async def get_all(
            self,
            column_id: uuid.UUID | None = None,
            assigned_to: uuid.UUID | None = None
    ) -> list[CardOut]:
        cards = await self.repo.get_all(column_id=column_id, assigned_to=assigned_to)
        return [CardOut.model_validate(c) for c in cards]
    
    async def create(self, data: CardCreate) -> CardOut:
        col = await self.column_repo.get_by_id(data.column_id)
        if not col:
            raise HTTPException(status_code=404, detail="Column not found")
        
        if data.assigned_to:
            user = await self.user_repo.get_user_by_id(data.assigned_to)
            if not user:
                raise HTTPException(status_code=404, detail="Assigned user not found")
            
        max_pos = await self.repo.get_max_position_in_column(data.column_id)
        card = await self.repo.create(
            title=data.title,
            column_id=data.column_id,
            position=max_pos + 1,
            created_by=data.created_by,
            description=data.description,
            assigned_to=data.assigned_to
        )
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')
        await self.event_repo.create('card_created', payload, str(card.id))
        await manager.publish('card_created', str(card.id), payload)
        logger.info(f'Card created: {card.id, card.title}')
        return out
    
    async def update(self, card_id: uuid.UUID, data: CardUpdate) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Card not found')
 
        updates: dict = {}
        event_type = 'card_updated'
        original_column_id = card.column_id
 
        if data.title is not None:
            updates['title'] = data.title
        if data.description is not None:
            updates['description'] = data.description
        if 'description' in data.model_fields_set and data.description is None:
            updates['description'] = None
 
        if data.assigned_to is not None:
            user = await self.user_repo.get_user_by_id(data.assigned_to)
            if not user:
                raise HTTPException(status_code=404, detail='Assigned user not found')
            updates['assigned_to'] = data.assigned_to
        if 'assigned_to' in data.model_fields_set and data.assigned_to is None:
            updates['assigned_to'] = None
 
        if data.column_id is not None and data.column_id != card.column_id:
            col = await self.column_repo.get_by_id(data.column_id)
            if not col:
                raise HTTPException(status_code=404, detail='Target column not found')
            max_pos = await self.repo.get_max_position_in_column(data.column_id)
            updates['column_id'] = data.column_id
            updates['position'] = max_pos + 1
            event_type = 'card_moved'
 
        card = await self.repo.update(card, **updates)
 
        if event_type == 'card_moved':
            await self.repo.normalize_position_in_column(original_column_id)
 
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')
        await self.event_repo.create(event_type, payload, str(card.id))
        await manager.publish(event_type, str(card.id), payload)
        
        logger.info(f"Card {event_type, card.id}")
        return out

    async def delete(self, card_id: uuid.UUID) -> None:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Card not found')

        column_id = card.column_id
        await self.repo.delete(card)
        await self.repo.normalize_position_in_column(column_id)
        payload = {'id': str(card_id)}
        await self.event_repo.create('card_deleted', payload, str(card_id))
        await manager.publish('card_deleted', str(card_id), payload)
        logger.info(f'Card deleted: {card_id}')

    async def move(self, card_id: uuid.UUID, data: CardMoveRequest) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Card not found')
 
        target_col = await self.column_repo.get_by_id(data.target_column_id)
        if not target_col:
            raise HTTPException(status_code=404, detail='Target column not found')
        
        source_column_id = card.column_id
        same_column = source_column_id == data.target_column_id

        if same_column:
            # cards = await self.repo.get_by_column_ordered(source_column_id)
            # max_pos = len(cards) - 1
            # target_pos = min(data.target_position, max_pos)

            # card = [c for c in cards if c.id != card_id]
            # cards.insert(target_pos, card)

            # for idx, c in enumerate(cards):
            #     c.position = idx
            # await self.session.flush()

            cards = await self.repo.get_by_column_ordered(source_column_id)
            if card in cards:
                cards.remove(card)

            max_pos = len(cards)
            target_pos = min(data.target_position, max_pos)

            cards.insert(target_pos, card)

            for idx, c in enumerate(cards):
                c.position = idx
            await self.session.flush()

        else:
            source_cards = await self.repo.get_by_column_ordered(source_column_id)
            source_cards = [c for c in source_cards if c.id != card_id]
            for idx, c in enumerate(source_cards):
                c.position = idx

            target_cards = await self.repo.get_by_column_ordered(data.target_column_id)
            max_target = len(target_cards)
            target_pos = min(data.target_position, max_target)

            for c in target_cards:
                if c.position >= target_pos:
                    c.position += 1

            card.column_id = data.target_column_id
            card.position = target_pos
            await self.session.flush()

        card.updated_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self.session.refresh(card)

        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')
        await self.event_repo.create('card_moved', payload, str(card.id))
        await manager.publish('card_moved', str(card.id), payload)
        logger.info(f'Card moved: {card_id} → column {data.target_column_id} pos {card.position}')
        return out