from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.event_service import EventService
from app.db.schemas import EventOut

router = APIRouter(prefix='/events', tags=['events'])

@router.get('', response_model=list[EventOut])
async def list_events(
    limit: int = Query(default= 50, ge=1, le=500),
    db: AsyncSession = Depends(get_db)
):
    return await EventService(db).get_recent(limit=limit)