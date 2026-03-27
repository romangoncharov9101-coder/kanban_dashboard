import uuid
from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.card_repo import CardRepository
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.repositories.user_repo import UserRepository
from app.repositories.notif_repo import NotificationRepository
from app.db.schemas import CardCreate, CardUpdate, CardMoveRequest, CardOut, CommentOut
from app.db.models import Attachment
from app.manager import manager
from app.core.logging import get_logger
from datetime import datetime, timezone
from sqlalchemy import select
from fastapi.responses import FileResponse
import os
import shutil

logger = get_logger('services.card')
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(_BASE_DIR, "uploads", "attachments")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

class CardService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = CardRepository(session)
        self.column_repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)
        self.user_repo = UserRepository(session)
        self.notif_repo = NotificationRepository(session)

    #======================================================
    # Cards
    #======================================================
    async def get_all(
            self,
            column_id: uuid.UUID | None = None,
            assigned_to: uuid.UUID | None = None,
            sort_by: str = 'position'
    ) -> list[CardOut]:
        cards = await self.repo.get_all(column_id=column_id, assigned_to=assigned_to, sort_by=sort_by)
        return [CardOut.model_validate(c) for c in cards]
    
    async def create(self, data: CardCreate) -> CardOut:
        col = await self.column_repo.get_by_id(data.column_id)
        if not col:
            raise HTTPException(status_code=404, detail="Колонка не найдена.")
        
        if data.assigned_to:
            user = await self.user_repo.get_user_by_id(data.assigned_to)
            if not user:
                raise HTTPException(status_code=404, detail="Исполняющий пользователь не найден.")
            
        max_pos = await self.repo.get_max_position_in_column(data.column_id)
        card = await self.repo.create(
            title=data.title,
            column_id=data.column_id,
            position=max_pos + 1,
            created_by=data.created_by,
            description=data.description,
            assigned_to=data.assigned_to,
            deadline=data.deadline,
            priority=data.priority
        )
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        if card.assigned_to and str(card.assigned_to) != str(data.created_by):
            creator = await self.user_repo.get_user_by_id(data.created_by)
            notif_msg = {
                'event': 'notification',
                'payload': {
                    'card_title': card.title,
                    'from_user': creator.username if creator else 'System',
                    'priority': card.priority,
                    'type': 'assigment'
                }
            }
            success = await manager.send_personal_message(str(card.assigned_to), notif_msg)

            if not success:
                await self.notif_repo.ensure_notification_exists(card.assigned_to, card.id)

        await self.event_repo.create('card_created', payload, str(card.id))
        await manager.publish('card_created', str(card.id), payload)
        await self.session.commit()
        logger.info(f'Card created: {card.id, card.title}')
        return out
    
    async def update(self, card_id: uuid.UUID, data: CardUpdate, current_user_id: uuid.UUID) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
 
        updates: dict = {}
        event_type = 'card_updated'
        original_column_id = card.column_id
        old_assignee = card.assigned_to
 
        if data.title is not None:
            updates['title'] = data.title
        if data.description is not None:
            updates['description'] = data.description
        if 'description' in data.model_fields_set and data.description is None:
            updates['description'] = None
        if 'deadline' in data.model_fields_set:
            updates['deadline'] = data.deadline
        if data.priority is not None:
            updates['priority'] = data.priority
 
        if data.assigned_to is not None:
            user = await self.user_repo.get_user_by_id(data.assigned_to)
            if not user:
                raise HTTPException(status_code=404, detail='Исполняющий пользователь не найден.')
            updates['assigned_to'] = data.assigned_to
        if 'assigned_to' in data.model_fields_set and data.assigned_to is None:
            updates['assigned_to'] = None
 
        if data.column_id is not None and data.column_id != card.column_id:
            col = await self.column_repo.get_by_id(data.column_id)
            if not col:
                raise HTTPException(status_code=404, detail='Целевая колонка не найдена.')
            max_pos = await self.repo.get_max_position_in_column(data.column_id)
            updates['column_id'] = data.column_id
            updates['position'] = max_pos + 1
            event_type = 'card_moved'
 
        card = await self.repo.update(card, **updates)
 
        if event_type == 'card_moved':
            await self.repo.normalize_position_in_column(original_column_id)

        new_assignee = updates.get('assigned_to')
        if new_assignee and new_assignee != old_assignee and str(new_assignee) != str(current_user_id):
            if old_assignee:
                await self.notif_repo.delete_all_for_user(old_assignee)

            updater = await self.user_repo.get_user_by_id(current_user_id)
            notif_msg = {
                'event': 'notification',
                'payload': {
                    'card_title': card.title,
                    'from_user': updater.username if updater else 'System',
                    'priority': card.priority,
                    'type': 'assigment'
                }
            }
            success = await manager.send_personal_message(str(new_assignee), notif_msg)

            if not success:
                await self.notif_repo.ensure_notification_exists(new_assignee, card.id)
        
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')
        await self.event_repo.create(event_type, payload, str(card.id))
        await manager.publish(event_type, str(card.id), payload)
        await self.session.commit()
        logger.info(f"Card {event_type, card.id}")
        return out

    async def delete(self, card_id: uuid.UUID) -> None:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        
        stmt = select(Attachment).where(Attachment.card_id == card_id)
        result = await self.session.execute(stmt)
        attachments = result.scalars().all()

        for at in attachments:
            if at.file_path and os.path.exists(at.file_path):
                try:
                    os.remove(at.file_path)
                    logger.info(f"File deleted from disk: {at.file_path}")
                except Exception as e:
                    logger.error(f"Error deleting file {at.file_path}: {e}")

        column_id = card.column_id
        await self.notif_repo.delete_by_card(card_id)
        await self.repo.delete(card)
        await self.repo.normalize_position_in_column(column_id)

        payload = {'id': str(card_id)}
        await self.event_repo.create('card_deleted', payload, str(card_id))
        await manager.publish('card_deleted', str(card_id), payload)
        await self.session.commit()

        logger.info(f'Card deleted: {card_id}')

    async def move(self, card_id: uuid.UUID, data: CardMoveRequest) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
 
        target_col = await self.column_repo.get_by_id(data.target_column_id)
        if not target_col:
            raise HTTPException(status_code=404, detail='Целевая колонка не найдена.')
        
        source_column_id = card.column_id
        same_column = source_column_id == data.target_column_id

        if same_column:
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
    
    #======================================================
    # Attachments
    #======================================================
    async def get_attachment(self, attachment_id: uuid.UUID) -> Attachment:
        stmt = select(Attachment).where(Attachment.id == attachment_id)
        result = await self.session.execute(stmt)
        attachment = result.scalar_one_or_none()
        
        if not attachment:
            logger.warning(f"Attachment {attachment_id} not found in DB")
            raise HTTPException(status_code=404, detail="Вложение не найдено.")
            
        return attachment
    
    async def get_attachment_file_response(self, attachment_id: uuid.UUID) -> FileResponse:
        attachment = await self.get_attachment(attachment_id)
        
        if not attachment.file_path or not os.path.exists(attachment.file_path):
            logger.error(f"File missing on disk: {attachment.file_path}")
            raise HTTPException(status_code=404, detail="Файл физически отсутствует на сервере.")

        return FileResponse(
            path=attachment.file_path,
            filename=attachment.filename,
            media_type=attachment.content_type
        )
    
    async def get_card_attachments(self, card_id: uuid.UUID) -> list[Attachment]:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail="Карточка не найдена.")
            
        stmt = select(Attachment).where(Attachment.card_id == card_id)
        result = await self.session.execute(stmt)
        return result.scalars().all()

    async def upload_card_file(self, card_id: uuid.UUID, file: UploadFile):
        count = await self.repo.get_attachment_count(card_id)
        if count >= 5:
            raise HTTPException(status_code=400, detail="Максимум 5 файлов на карточку.")
        
        MAX_SIZE = 5 * 1024 * 1024
        file_content = await file.read()
        if len(file_content) > MAX_SIZE:
            raise HTTPException(status_code=413, detail="Файл слишком большой (максимальный размер файла 5MB).")
        
        file_extension = os.path.splitext(file.filename)[1]
        unique_filename = f'{card_id}_{os.urandom(4).hex()}{file_extension}'
        file_path = os.path.join(UPLOAD_DIR, unique_filename)

        with open(file_path, 'wb') as buffer:
            buffer.write(file_content)

        attachment_data = {
            'card_id': card_id,
            'filename': file.filename,
            'stored_filename': unique_filename,
            'file_path': file_path,
            'content_type': file.content_type
        }
        attachment = await self.repo.add_attachment(attachment_data)
        updated_card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(updated_card)
        payload = out.model_dump(mode='json')
        await manager.publish('card_updated', str(card_id), payload)

        await self.session.commit()
        logger.info(f"Attachment saved to DB: {attachment.id} for card {card_id}")
        return attachment
    
    async def delete_attachment(self, attachment_id: uuid.UUID):
        attachment = await self.repo.get_attachment_by_id(attachment_id)
        if not attachment:
            raise HTTPException(status_code=404, detail="Карточка не найдена.")
        
        stmt = select(Attachment).where(Attachment.id == attachment_id)
        result = await self.session.execute(stmt)
        attachment = result.scalar_one_or_none()
        card_id = attachment.card_id

        if not attachment:
            raise HTTPException(status_code=404, detail='Вложение не найдено.')
        
        try:
            if attachment.file_path and os.path.exists(attachment.file_path):
                os.remove(attachment.file_path)
                logger.info(f"Attachment successfully deleted: {attachment.file_path}")
            else:
                logger.warning(f"File nou found. Skip deleting file: {attachment.file_path}")
        except Exception as e:
            logger.error(f"Error while deleting file {attachment.file_path}: {e}")

        updated_card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(updated_card)
        payload = out.model_dump(mode='json')
        await manager.publish('card_updated', str(card_id), payload)

        await self.repo.delete_attachment(attachment_id)
        await self.session.commit()
        return {'status': 'success'}
    
    #======================================================
    # Comments
    #======================================================
    async def add_comment(self, card_id: uuid.UUID, user_id:uuid.UUID, text: str) -> CommentOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        
        comment = await self.repo.add_comment(card_id, user_id, text)
        out = CommentOut.model_validate(comment)
        payload = out.model_dump(mode='json')

        await self.event_repo.create('comment_created', payload, str(card_id))
        await manager.publish('comment_created', str(card_id), payload)
        await self.session.commit()
        logger.info(f'Comment {comment.id} added to card {card_id} by user {user_id}')
        return out
    
    async def edit_comment(self, comment_id: uuid.UUID, user_id: uuid.UUID, new_text: str) -> CommentOut:
        comment = await self.repo.get_comment_by_id(comment_id)
        if not comment:
            raise HTTPException(status_code=404, detail='Комментарий не существует.')
        
        if str(comment.user_id) != str(user_id):
            logger.warnning(f'User {user_id} tried to edit comment {comment_id} owned by {comment.user_id}')
            raise HTTPException(status_code=405, detail='Вы не можете редактировать чужой комментарий.')
        
        updated_comment = await self.repo.edit_comment(comment_id, new_text)
        out = CommentOut.model_validate(updated_comment)
        payload = out.model_dump(mode='json')

        await self.event_repo.create('comment_updated', payload, str(comment.card_id))
        await manager.publish('comment_updated', str(comment.card_id), payload)

        await self.session.commit()
        logger.info(f"Comment {comment_id} updated by user {user_id}")
        return out
    
    async def delete_comments(self, comment_id: uuid.UUID, user_id: uuid.UUID) -> None:
        comment = await self.repo.get_comment_by_id(comment_id)
        if not comment:
            raise HTTPException(status_code=404, detail='Комментарий не существует.')
        
        if str(comment.user_id) != str(user_id):
            logger.warnning(f'User {user_id} tried to edit comment {comment_id} owned by {comment.user_id}')
            raise HTTPException(status_code=405, detail='Вы не можете удалить чужой комментарий.')
        
        card_id = comment.card_id
        await self.repo.delete_comment(comment)
        payload = {'id': str(comment_id), 'card_id': str(card_id)}
        
        await self.event_repo.create('comment_deleted', payload, str(card_id))
        await manager.publish('comment_deleted', str(card_id), payload)
        await self.session.commit()
        logger.info(f"Comment {comment_id} deleted by user {user_id}")
        return {"status": "success"}
    
    async def get_comments(self, card_id: uuid.UUID, last_id: uuid.UUID | None = None) -> list[CommentOut]:
        comments = await self.repo.get_comments_paginated(card_id, last_id)
        return [CommentOut.model_validate(c) for c in comments]

