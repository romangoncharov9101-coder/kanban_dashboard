import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_admin
from app.db.models import EventType as EventTypeModel, User
from app.db.schemas import EventOut, EventPage
from app.db.session import get_db
from app.services.event_service import EventService

router = APIRouter(prefix='/events', tags=['events'])


@router.get('', response_model=list[EventOut])
async def get_events(
    card_id: uuid.UUID | None = Query(None, description="История конкретной задачи"),
    limit: int = Query(default=50, ge=1, le=500),
    last_id: uuid.UUID | None = Query(None, description="ID последнего загруженного события"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    service = EventService(db)
    if card_id:
        return await service.get_card_history(card_id=card_id, viewer=current_user, limit=limit, last_id=last_id)
    return await service.get_recent_global(viewer=current_user, limit=limit)


@router.get('/journal', response_model=EventPage)
async def get_journal(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    event_type: list[EventTypeModel] | None = Query(None, description="Фильтр по типам событий"),
    category: str | None = Query(None, description="card | column | project | user"),
    user_id: uuid.UUID | None = Query(None, description="Кто выполнил действие"),
    project_id: uuid.UUID | None = Query(None),
    q: str | None = Query(None, description="Поиск по тексту, задаче, проекту, пользователю"),
    date_from: datetime | None = Query(None),
    date_to: datetime | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Полный журнал действий. Доступен только администратору."""
    return await EventService(db).get_journal(
        limit=limit, offset=offset,
        event_types=event_type, category=category,
        user_id=user_id, project_id=project_id,
        search=q, date_from=date_from, date_to=date_to,
    )


@router.get('/journal/types')
async def get_journal_types(current_user: User = Depends(require_admin)):
    """Справочник типов событий с русскими подписями — для фильтров."""
    return EventService.type_catalog()
