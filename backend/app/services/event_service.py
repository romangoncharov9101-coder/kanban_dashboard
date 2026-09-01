import uuid
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Event, EventType as EventTypeModel, User, UserRole, card_assignees
from app.db.schemas import EventOut, EventPage, EventType
from app.repositories.card_repo import CardRepository
from app.repositories.event_repo import EventRepository


class EventService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = EventRepository(session)
        self.card_repo = CardRepository(session)

    async def log_event(self, event_type: EventType, message: str, card_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None, payload: dict | None = None) -> EventOut:
        event = await self.repo.create(
            event_type=event_type,
            message=message,
            card_id=card_id,
            user_id=user_id,
            payload=payload or {}
        )
        return EventOut.model_validate(event)

    async def get_card_history(self, card_id: uuid.UUID, viewer: User, limit: int = 20, last_id: uuid.UUID | None = None) -> list[EventOut]:
        card = await self.card_repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        if not viewer.is_manager and not card.is_assignee(viewer.user_id):
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

        events = await self.repo.get_by_card(card_id, limit=limit, last_id=last_id)
        return [EventOut.model_validate(e) for e in events]

    async def get_recent_global(self, viewer: User, limit: int = 50) -> list[EventOut]:
        """
        Менеджеры видят всю ленту. Обычный пользователь — только события
        по своим карточкам, иначе через историю утекали бы чужие задачи.
        """
        if viewer.is_manager:
            events = await self.repo.get_recent(limit=limit)
            return [EventOut.model_validate(e) for e in events]

        visible_cards = select(card_assignees.c.card_id).where(
            card_assignees.c.user_id == viewer.user_id
        )
        result = await self.session.execute(
            select(Event)
            .where(Event.card_id.in_(visible_cards))
            .options(selectinload(Event.user))
            .order_by(Event.created_at.desc())
            .limit(limit)
        )
        return [EventOut.model_validate(e) for e in result.scalars().all()]

    #======================================================
    # Журнал действий (только администратор)
    #======================================================
    TYPE_LABELS = {
        'CARD_CREATED':       ('Задача создана', 'card'),
        'CARD_EDITED':        ('Задача изменена', 'card'),
        'CARD_MOVED':         ('Задача перемещена', 'card'),
        'CARD_ASSIGNED':      ('Исполнители изменены', 'card'),
        'CARD_STATUS_CHANGED':('Статус изменён', 'card'),
        'CARD_ARCHIVED':      ('Задача в архиве', 'card'),
        'CARD_RESTORED':      ('Задача восстановлена', 'card'),
        'CARD_DELETED':       ('Задача удалена', 'card'),
        'COMMENT_ADDED':      ('Комментарий добавлен', 'card'),
        'COMMENT_EDITED':     ('Комментарий изменён', 'card'),
        'COMMENT_DELETED':    ('Комментарий удалён', 'card'),
        'ATTACHMENT_ADDED':   ('Файл прикреплён', 'card'),
        'ATTACHMENT_DELETED': ('Файл удалён', 'card'),
        'COLUMN_CREATED':     ('Категория создана', 'column'),
        'COLUMN_UPDATED':     ('Категория изменена', 'column'),
        'COLUMN_DELETED':     ('Категория удалена', 'column'),
        'PROJECT_CREATED':    ('Проект создан', 'project'),
        'PROJECT_UPDATED':    ('Проект изменён', 'project'),
        'PROJECT_DELETED':    ('Проект удалён', 'project'),
        'USER_CREATED':       ('Пользователь создан', 'user'),
        'USER_UPDATED':       ('Пользователь изменён', 'user'),
        'USER_DEACTIVATED':   ('Пользователь отключён', 'user'),
        'USER_LOGIN':         ('Вход в систему', 'user'),
        'USER_LOGOUT':        ('Выход из системы', 'user'),
    }

    @classmethod
    def type_catalog(cls) -> list[dict]:
        return [
            {'value': value, 'label': label, 'category': category}
            for value, (label, category) in cls.TYPE_LABELS.items()
        ]

    @classmethod
    def _types_of_category(cls, category: str) -> list[EventTypeModel]:
        return [
            EventTypeModel(value)
            for value, (_, cat) in cls.TYPE_LABELS.items()
            if cat == category
        ]

    async def get_journal(
        self,
        limit: int = 50,
        offset: int = 0,
        event_types=None,
        category: str | None = None,
        user_id=None,
        project_id=None,
        search: str | None = None,
        date_from=None,
        date_to=None,
    ) -> EventPage:
        # Категория — это просто удобная группа типов, а не отдельное поле
        types = list(event_types) if event_types else None
        if not types and category:
            types = self._types_of_category(category)

        items, total = await self.repo.get_journal(
            limit=limit,
            offset=offset,
            event_types=types,
            user_id=user_id,
            project_id=project_id,
            search=search,
            date_from=date_from,
            date_to=date_to,
        )
        return EventPage(
            items=[EventOut.model_validate(e) for e in items],
            total=total,
            limit=limit,
            offset=offset,
        )

    async def cleanup_old_events(self, days: int = 30):
        seconds = days * 24 * 3600
        return await self.repo.delete_older_than(seconds)
