import os
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.models import Attachment, Card, User, UserRole
from app.db.schemas import (
    CardCreate, CardMoveRequest, CardOut, CardUpdate, CommentOut, EventType,
)
from app.manager import manager
from app.repositories.card_repo import CardRepository
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.repositories.notif_repo import NotificationRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.user_repo import UserRepository

logger = get_logger('services.card')
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(_BASE_DIR, "uploads", "attachments")
os.makedirs(UPLOAD_DIR, exist_ok=True)


class CardService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = CardRepository(session)
        self.column_repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)
        self.user_repo = UserRepository(session)
        self.notif_repo = NotificationRepository(session)
        self.project_repo = ProjectRepository(session)

    #======================================================
    # Права доступа
    #======================================================
    @staticmethod
    def _audience(card: Card) -> set[str]:
        """
        Кому адресованы WS-события по карточке: исполнители и автор.
        Админы получают всё (include_privileged в manager.publish).
        Постановщик, не связанный с карточкой, событий по ней не получает.
        """
        aud = {str(u.user_id) for u in card.assignees}
        aud.add(str(card.created_by))
        return aud

    @staticmethod
    def _can_view(card: Card, user: User) -> bool:
        """
        ADMIN     — видит всё.
        TEAM_LEAD — свои созданные плюс те, где он сам исполнитель.
                    Чужие задачи (в том числе созданные админом) не видит.
        USER      — только назначенные ему.
        """
        if user.role is UserRole.ADMIN:
            return True
        if card.is_assignee(user.user_id):
            return True
        return user.role is UserRole.TEAM_LEAD and str(card.created_by) == str(user.user_id)

    @staticmethod
    def _can_manage(card: Card, user: User) -> bool:
        """
        Право менять саму задачу: заголовок, описание, дедлайн,
        приоритет, состав исполнителей, архивацию и удаление.
        Принадлежит админу и автору задачи. Быть исполнителем — мало.
        """
        if user.role is UserRole.ADMIN:
            return True
        return user.role is UserRole.TEAM_LEAD and str(card.created_by) == str(user.user_id)

    def _assert_can_view(self, card: Card, user: User) -> None:
        if not self._can_view(card, user):
            # 404, а не 403: не подтверждаем существование чужой карточки.
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

    def _assert_can_manage(self, card: Card, user: User) -> None:
        # Сначала видимость: тому, кто карточку видеть не должен,
        # отвечаем 404 и не выдаём фактом 403, что она существует.
        self._assert_can_view(card, user)
        if not self._can_manage(card, user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='Изменять задачу может только её автор или администратор.',
            )

    def _assert_can_comment(self, card: Card, user: User) -> None:
        self._assert_can_view(card, user)

    def _visible_subset(self, cards: list[Card], user: User) -> list[Card]:
        return [c for c in cards if self._can_view(c, user)]

    async def _resolve_assignees(self, assignee_ids: list[uuid.UUID]) -> list[User]:
        if not assignee_ids:
            return []
        users = await self.user_repo.get_users_by_ids(assignee_ids)
        found = {u.user_id for u in users}
        missing = [str(uid) for uid in assignee_ids if uid not in found]
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f'Исполнитель не найден: {", ".join(missing)}',
            )
        inactive = [u.username for u in users if not u.is_active]
        if inactive:
            raise HTTPException(
                status_code=400,
                detail=f'Нельзя назначить деактивированного пользователя: {", ".join(inactive)}',
            )
        return users

    async def _notify_assignees(self, card: Card, user_ids: set[uuid.UUID], actor: User) -> None:
        for uid in user_ids:
            if str(uid) == str(actor.user_id):
                continue
            notif_msg = {
                'event': 'notification',
                'payload': {
                    'card_title': card.title,
                    'from_user': actor.username,
                    'priority': card.priority,
                    'type': 'assigment',
                },
            }
            delivered = await manager.send_personal_message(str(uid), notif_msg)
            if not delivered:
                await self.notif_repo.ensure_notification_exists(uid, card.id)

    #======================================================
    # Cards
    #======================================================
    async def get_all(
            self,
            viewer: User,
            column_id: uuid.UUID | None = None,
            assigned_to: uuid.UUID | None = None,
            project_ids: list[uuid.UUID] | None = None,
    ) -> list[CardOut]:
        # Фильтр видимости навязывается сервером и не зависит от
        # параметров запроса: клиент не может расширить себе выдачу.
        visible_for = None if viewer.role is UserRole.ADMIN else viewer.user_id
        cards = await self.repo.get_all(
            column_id=column_id,
            assigned_to=assigned_to,
            visible_for=visible_for,
            include_own_created=viewer.role is UserRole.TEAM_LEAD,
            project_ids=project_ids,
        )
        return [CardOut.model_validate(c) for c in cards]

    async def get_one(self, card_id: uuid.UUID, viewer: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_view(card, viewer)
        return CardOut.model_validate(card)

    async def create(self, data: CardCreate, author: User) -> CardOut:
        col = await self.column_repo.get_by_id(data.column_id)
        if not col:
            raise HTTPException(status_code=404, detail="Колонка не найдена.")

        # Проект берём из колонки, а не из тела запроса: так карточка
        # физически не может оказаться в чужом проекте.
        from app.services.project_service import ProjectService
        await ProjectService(self.session).assert_can_manage(col.project_id, author)

        assignees = await self._resolve_assignees(data.assignee_ids)

        max_pos = await self.repo.get_max_position_in_column(data.column_id)
        card = await self.repo.create(
            title=data.title,
            column_id=data.column_id,
            position=max_pos + 1,
            created_by=author.user_id,
            description=data.description,
            deadline=data.deadline,
            priority=data.priority,
            assignees=assignees,
            project_id=col.project_id,
        )
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self._notify_assignees(card, {u.user_id for u in assignees}, author)

        await self.event_repo.create(
            event_type=EventType.CARD_CREATED,
            message=f"Карточка создана в категории '{col.name}'",
            card_id=card.id,
            user_id=author.user_id,
            payload=payload
        )
        await manager.publish('card_created', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Card created: {card.id, card.title}')
        return out

    async def update(self, card_id: uuid.UUID, data: CardUpdate, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        updates: dict = {}
        log_details = []
        sent_fields = data.model_fields_set

        old_assignee_ids = {u.user_id for u in card.assignees}
        new_assignee_ids = old_assignee_ids

        if 'title' in sent_fields and data.title is not None and data.title != card.title:
            updates['title'] = data.title
            log_details.append(f"изменил название на '{data.title}'")

        if 'description' in sent_fields and data.description != card.description:
            updates['description'] = data.description
            log_details.append("обновил описание")

        if 'deadline' in sent_fields and data.deadline != card.deadline:
            updates['deadline'] = data.deadline
            date_str = data.deadline.strftime('%d.%m.%Y') if data.deadline else "удален"
            log_details.append(f"установил дедлайн: {date_str}")

        if 'priority' in sent_fields and data.priority is not None and data.priority != card.priority:
            updates['priority'] = data.priority
            p_name = data.priority.value if hasattr(data.priority, 'value') else str(data.priority)
            log_details.append(f"сменил приоритет на {p_name.split('.')[-1]}")

        # Исполнители: полная замена списка
        assignees_changed = False
        if 'assignee_ids' in sent_fields and data.assignee_ids is not None:
            requested = set(data.assignee_ids)
            if requested != old_assignee_ids:
                users = await self._resolve_assignees(data.assignee_ids)
                new_assignee_ids = {u.user_id for u in users}
                assignees_changed = True
                if users:
                    log_details.append(f"назначил исполнителей: {', '.join(u.username for u in users)}")
                else:
                    log_details.append("убрал всех исполнителей")

        event_type = EventType.CARD_EDITED
        original_column_id = card.column_id

        if 'column_id' in sent_fields and data.column_id is not None and data.column_id != card.column_id:
            target_col = await self.column_repo.get_by_id(data.column_id)
            if not target_col:
                raise HTTPException(status_code=404, detail='Целевая категория не найдена.')
            if target_col.project_id != card.project_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail='Нельзя перенести задачу в категорию другого проекта.',
                )

            max_pos = await self.repo.get_max_position_in_column(data.column_id)
            updates['column_id'] = data.column_id
            updates['position'] = max_pos + 1

            event_type = EventType.CARD_MOVED
            log_details.append(f"переместил карточку в категорию '{target_col.name}'")

        if not updates and not assignees_changed:
            return CardOut.model_validate(card)

        if assignees_changed:
            await self.repo.set_assignees(card, list(new_assignee_ids))

        if updates:
            card = await self.repo.update(card, **updates)
        else:
            card = await self.repo.get_by_id(card.id)

        if event_type == EventType.CARD_MOVED:
            await self.repo.normalize_position_in_column(original_column_id)

        # Уведомления только новым исполнителям
        added = new_assignee_ids - old_assignee_ids
        removed = old_assignee_ids - new_assignee_ids
        if added:
            await self._notify_assignees(card, added, actor)
        for uid in removed:
            await self.notif_repo.delete_specific_notification(uid, card.id)

        final_message = "; ".join(log_details).capitalize() or "Обновил карточку"

        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=event_type,
            message=final_message,
            card_id=card.id,
            user_id=actor.user_id,
            payload=payload
        )

        ws_event = "card_moved" if event_type == EventType.CARD_MOVED else "card_updated"
        await manager.publish(ws_event, str(card.id), payload, audience=self._audience(card))

        # Снятым исполнителям карточка больше не видна — говорим их клиентам
        # убрать её с доски, иначе она зависнет до перезагрузки страницы.
        if removed:
            await manager.publish(
                'card_unassigned',
                str(card.id),
                {'id': str(card.id)},
                audience={str(u) for u in removed},
                include_privileged=False,
            )

        await self.session.commit()
        return out

    async def delete(self, card_id: uuid.UUID, actor: User) -> None:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        audience = self._audience(card)

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
        title = card.title
        await self.notif_repo.delete_by_card(card_id)
        await self.repo.delete(card)
        await self.repo.normalize_position_in_column(column_id)

        payload = {'id': str(card_id)}
        await self.event_repo.create(
            event_type=EventType.CARD_DELETED,
            message=f"Удалил карточку '{title}'",
            card_id=None,
            user_id=actor.user_id
        )
        await manager.publish('card_deleted', str(card_id), payload, audience=audience)
        await self.session.commit()

        logger.info(f'Card deleted: {card_id}')

    def _resolve_absolute_position(
        self,
        ordered_cards: list[Card],
        actor: User,
        visible_position: int,
    ) -> int:
        """
        Переводит позицию из системы координат клиента в абсолютную.

        Клиент присылает индекс внутри того списка, который видит сам.
        У постановщика и исполнителя это подмножество колонки, поэтому
        принимать число как абсолютную позицию нельзя: карточка уехала бы
        мимо места, куда её бросили, и порядок у остальных поехал бы.

        ordered_cards — все карточки целевой колонки по возрастанию position,
        без перемещаемой. Возвращает индекс вставки в этот полный список.
        """
        if actor.role is UserRole.ADMIN:
            return min(visible_position, len(ordered_cards))

        visible = self._visible_subset(ordered_cards, actor)

        # Бросили ниже последней видимой карточки — значит в конец колонки.
        if visible_position >= len(visible):
            return len(ordered_cards)

        # Иначе встаём прямо перед той видимой карточкой,
        # которая сейчас занимает это место.
        anchor = visible[visible_position]
        return ordered_cards.index(anchor)

    async def move(self, card_id: uuid.UUID, data: CardMoveRequest, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

        self._assert_can_view(card, actor)

        target_col = await self.column_repo.get_by_id(data.target_column_id)
        if not target_col:
            raise HTTPException(status_code=404, detail='Целевая категория не найдена.')
        if target_col.project_id != card.project_id:
            # Доски проектов независимы: перетаскивание между ними
            # означало бы смену принадлежности задачи втихую.
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail='Задачу нельзя перетащить в другой проект.',
            )

        source_column_id = card.column_id
        same_column = source_column_id == data.target_column_id

        # Автор задачи и админ таскают её куда угодно. Тот, кто просто
        # назначен исполнителем, ограничен списком разрешённых категорий —
        # даже если он постановщик, но задачу создал не он.
        unrestricted = self._can_manage(card, actor)

        if not unrestricted and not same_column and not target_col.is_user_movable:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Перемещение в категорию '{target_col.name}' вам недоступно.",
            )

        if same_column:
            cards = await self.repo.get_by_column_ordered(source_column_id)
            cards = [c for c in cards if c.id != card_id]

            target_pos = self._resolve_absolute_position(cards, actor, data.target_position)
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
            target_pos = self._resolve_absolute_position(target_cards, actor, data.target_position)

            for c in target_cards:
                if c.position >= target_pos:
                    c.position += 1

            card.column_id = data.target_column_id
            card.position = target_pos
            await self.session.flush()

        card.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

        card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        if same_column:
            log_msg = f"Изменил приоритет отображения (позиция {card.position})"
        else:
            log_msg = f"Переместил карточку в категорию '{target_col.name}' на позицию {card.position}"

        await self.event_repo.create(
            event_type=EventType.CARD_MOVED,
            message=log_msg,
            card_id=card.id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish('card_moved', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Card moved: {card_id} -> column {data.target_column_id} pos {card.position}')
        return out

    async def archive(self, card_id: uuid.UUID, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        card.is_archived = True
        await self.session.flush()
        card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.CARD_ARCHIVED,
            message=f'Карточка "{card.title}" перемещена в архив.',
            card_id=card_id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish('card_archived', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        return out

    async def unarchive(self, card_id: uuid.UUID, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        card.is_archived = False
        await self.session.flush()
        card = await self.repo.get_by_id(card_id)

        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.CARD_RESTORED,
            message=f"Карточка '{card.title}' восстановлена из архива",
            card_id=card.id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish('card_restored', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
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

    async def get_attachment_file_response(self, attachment_id: uuid.UUID, viewer: User) -> FileResponse:
        attachment = await self.get_attachment(attachment_id)

        card = await self.repo.get_by_id(attachment.card_id)
        if card:
            self._assert_can_view(card, viewer)

        if not attachment.file_path or not os.path.exists(attachment.file_path):
            logger.error(f"File missing on disk: {attachment.file_path}")
            raise HTTPException(status_code=404, detail="Файл физически отсутствует на сервере.")

        return FileResponse(
            path=attachment.file_path,
            filename=attachment.filename,
            media_type=attachment.content_type
        )

    async def get_card_attachments(self, card_id: uuid.UUID, viewer: User) -> list[Attachment]:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail="Карточка не найдена.")
        self._assert_can_view(card, viewer)

        stmt = select(Attachment).where(Attachment.card_id == card_id)
        result = await self.session.execute(stmt)
        return result.scalars().all()

    async def upload_card_file(self, card_id: uuid.UUID, file: UploadFile, actor: User):
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail="Карточка не найдена.")
        self._assert_can_comment(card, actor)

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

        await self.event_repo.create(
            event_type=EventType.CARD_EDITED,
            message=f"Прикреплен файл {file.filename}",
            card_id=card_id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish('card_updated', str(card_id), payload, audience=self._audience(updated_card))

        await self.session.commit()
        logger.info(f"Attachment saved to DB: {attachment.id} for card {card_id}")
        return attachment

    async def delete_attachment(self, attachment_id: uuid.UUID, actor: User):
        attachment = await self.repo.get_attachment_by_id(attachment_id)
        if not attachment:
            raise HTTPException(status_code=404, detail="Вложение не найдено")

        card_id = attachment.card_id
        card = await self.repo.get_by_id(card_id)
        if card:
            self._assert_can_comment(card, actor)

        try:
            if attachment.file_path and os.path.exists(attachment.file_path):
                os.remove(attachment.file_path)
                logger.info(f"Attachment successfully deleted: {attachment.file_path}")
            else:
                logger.warning(f"File not found. Skip deleting file: {attachment.file_path}")
        except Exception as e:
            logger.error(f"Error while deleting file {attachment.file_path}: {e}")

        filename = attachment.filename
        await self.repo.delete_attachment(attachment_id)
        await self.session.flush()

        updated_card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(updated_card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.CARD_EDITED,
            message=f"Удален файл: {filename}",
            card_id=card_id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish('card_updated', str(card_id), payload, audience=self._audience(updated_card))
        await self.session.commit()
        return {'status': 'success'}

    #======================================================
    # Comments
    #======================================================
    async def add_comment(self, card_id: uuid.UUID, actor: User, text: str) -> CommentOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_comment(card, actor)

        comment = await self.repo.add_comment(card_id, actor.user_id, text)
        out = CommentOut.model_validate(comment)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.COMMENT_ADDED,
            message=f"Добавил комментарий: {text[:50]}{'...' if len(text) > 50 else ''}",
            card_id=card_id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish('comment_created', str(card_id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Comment {comment.id} added to card {card_id} by user {actor.user_id}')
        return out

    async def edit_comment(self, comment_id: uuid.UUID, actor: User, new_text: str) -> CommentOut:
        comment = await self.repo.get_comment_by_id(comment_id)
        if not comment:
            raise HTTPException(status_code=404, detail='Комментарий не существует.')

        if str(comment.user_id) != str(actor.user_id):
            logger.warning(f'User {actor.user_id} tried to edit comment {comment_id} owned by {comment.user_id}')
            raise HTTPException(status_code=403, detail='Вы не можете редактировать чужой комментарий.')

        card = await self.repo.get_by_id(comment.card_id)
        updated_comment = await self.repo.edit_comment(comment_id, new_text)
        out = CommentOut.model_validate(updated_comment)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.COMMENT_EDITED,
            message="Отредактировал свой комментарий",
            card_id=comment.card_id,
            user_id=actor.user_id,
            payload=payload
        )
        await manager.publish(
            'comment_updated', str(comment.card_id), payload,
            audience=self._audience(card) if card else None,
        )

        await self.session.commit()
        logger.info(f"Comment {comment_id} updated by user {actor.user_id}")
        return out

    async def delete_comments(self, comment_id: uuid.UUID, actor: User) -> None:
        comment = await self.repo.get_comment_by_id(comment_id)
        if not comment:
            raise HTTPException(status_code=404, detail='Комментарий не существует.')

        # Свой комментарий удаляет автор комментария.
        # Чужой — админ или автор самой задачи (модерация своей задачи).
        card_for_perm = await self.repo.get_by_id(comment.card_id)
        may_moderate = card_for_perm is not None and self._can_manage(card_for_perm, actor)
        if str(comment.user_id) != str(actor.user_id) and not may_moderate:
            logger.warning(f'User {actor.user_id} tried to delete comment {comment_id} owned by {comment.user_id}')
            raise HTTPException(status_code=403, detail='Вы не можете удалить чужой комментарий.')

        card_id = comment.card_id
        card = await self.repo.get_by_id(card_id)
        await self.repo.delete_comment(comment)
        payload = {'id': str(comment_id), 'card_id': str(card_id)}

        await self.event_repo.create(
            event_type=EventType.COMMENT_DELETED,
            message="Удалил комментарий",
            card_id=card_id,
            user_id=actor.user_id,
            payload=payload
        )

        await manager.publish(
            'comment_deleted', str(card_id), payload,
            audience=self._audience(card) if card else None,
        )
        await self.session.commit()
        logger.info(f"Comment {comment_id} deleted by user {actor.user_id}")
        return {"status": "success"}

    async def get_comments(self, card_id: uuid.UUID, viewer: User, last_id: uuid.UUID | None = None) -> list[CommentOut]:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_view(card, viewer)

        comments = await self.repo.get_comments_paginated(card_id, last_id)
        return [CommentOut.model_validate(c) for c in comments]
