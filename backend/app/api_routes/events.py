from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.event_service import EventService
from app.db.schemas import EventOut
from app.db.models import User
from app.core.deps import get_current_user
import uuid

router = APIRouter(prefix='/events', tags=['events'])

# @router.get('', response_model=list[EventOut])
# async def list_events(
#     limit: int = Query(default= 50, ge=1, le=500),
#     db: AsyncSession = Depends(get_db),
#     current_user: User = Depends(get_current_user)
# ):
#     return await EventService(db).get_recent(limit=limit)

@router.get('', response_model=list[EventOut])
async def get_events(
    card_id: uuid.UUID | None = Query(None, description="ID карточки для получения истории конкретной задачи"),
    limit: int = Query(default=50, ge=1, le=500),
    last_id: uuid.UUID | None = Query(None, description="ID последнего загруженного ивента"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    service = EventService(db)
    
    if card_id:
        return await service.get_card_history(card_id=card_id, limit=limit, last_id=last_id)
    
    return await service.get_recent_global(limit=limit)