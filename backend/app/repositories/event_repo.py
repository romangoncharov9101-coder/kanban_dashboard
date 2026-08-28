import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.audit import write_audit_record
from app.db.models import Event, EventType, User


class EventRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(
        self,
        event_type: EventType,
        message: str,
        card_id: uuid.UUID | None = None,
        user_id: uuid.UUID | None = None,
        payload: dict | None = None,
        *,
        actor: User | None = None,
        actor_username: str | None = None,
        actor_role: str | None = None,
        card_title: str | None = None,
        project_id: uuid.UUID | None = None,
        project_name: str | None = None,
        column_name: str | None = None,
        target_username: str | None = None,
    ) -> Event:
        """
        Пишет событие в БД и дублирует в файловый архив.

        Названия сохраняются строками прямо в событии: если карточку
        или проект потом удалят, запись останется читаемой.
        """
        if actor is not None:
            user_id = user_id or actor.user_id
            actor_username = actor_username or actor.username
            actor_role = actor_role or (actor.role.value if actor.role else None)

        ev = Event(
            id=uuid.uuid4(),
            event_type=event_type,
            message=message,
            card_id=card_id,
            card_title=card_title,
            project_id=project_id,
            project_name=project_name,
            column_name=column_name,
            target_username=target_username,
            user_id=user_id,
            actor_username=actor_username,
            actor_role=actor_role,
            payload=payload or {},
            created_at=datetime.now(timezone.utc),
        )
        self.session.add(ev)
        await self.session.flush()

        write_audit_record({
            'id': str(ev.id),
            'event_type': event_type.value,
            'message': message,
            'actor': actor_username,
            'actor_role': actor_role,
            'target_user': target_username,
            'project': project_name,
            'column': column_name,
            'card': card_title,
            'card_id': str(card_id) if card_id else None,
            'project_id': str(project_id) if project_id else None,
        })
        return ev

    async def get_by_card(self, card_id: uuid.UUID, limit: int = 20, last_id: uuid.UUID | None = None) -> list[Event]:
        query = (
            select(Event)
            .where(Event.card_id == card_id)
            .options(selectinload(Event.user))
            .order_by(Event.created_at.desc())
        )
        if last_id:
            last_event_res = await self.session.execute(
                select(Event.created_at).where(Event.id == last_id)
            )
            last_created_at = last_event_res.scalar()
            if last_created_at:
                query = query.where(Event.created_at < last_created_at)

        result = await self.session.execute(query.limit(limit))
        return list(result.scalars().all())

    async def get_recent(self, limit: int = 50) -> list[Event]:
        result = await self.session.execute(
            select(Event)
            .options(selectinload(Event.user))
            .order_by(Event.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    #======================================================
    # Журнал действий: выборка с фильтрами и постраничностью
    #======================================================
    def _journal_query(
        self,
        event_types: list[EventType] | None = None,
        user_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
        search: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ):
        q = select(Event)

        if event_types:
            q = q.where(Event.event_type.in_(event_types))
        if user_id:
            q = q.where(Event.user_id == user_id)
        if project_id:
            q = q.where(Event.project_id == project_id)
        if date_from:
            q = q.where(Event.created_at >= date_from)
        if date_to:
            q = q.where(Event.created_at <= date_to)
        if search:
            pattern = f'%{search.strip()}%'
            q = q.where(or_(
                Event.message.ilike(pattern),
                Event.card_title.ilike(pattern),
                Event.actor_username.ilike(pattern),
                Event.project_name.ilike(pattern),
                Event.target_username.ilike(pattern),
            ))
        return q

    async def get_journal(self, limit: int = 50, offset: int = 0, **filters) -> tuple[list[Event], int]:
        base = self._journal_query(**filters)

        total = await self.session.execute(
            select(func.count()).select_from(base.subquery())
        )
        result = await self.session.execute(
            base.options(selectinload(Event.user))
            .order_by(Event.created_at.desc(), Event.id.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all()), (total.scalar() or 0)

    async def delete(self, event: Event) -> None:
        await self.session.delete(event)
        await self.session.flush()

    async def delete_older_than(self, max_age_seconds: int) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
        result = await self.session.execute(
            delete(Event).where(Event.created_at < cutoff)
        )
        await self.session.flush()
        return result.rowcount
