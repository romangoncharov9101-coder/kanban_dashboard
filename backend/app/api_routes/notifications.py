import uuid
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.repositories.notif_repo import NotificationRepository
from app.core.deps import get_current_user
from app.db.models import User

router = APIRouter(prefix='/notifications', tags=['Notifications'])

@router.get('/check')
async def check_notifications(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return {'has_new_tasks': await NotificationRepository(db).get_all_for_user(current_user.user_id)}

@router.delete('/clear', status_code=status.HTTP_204_NO_CONTENT)
async def clear_notification(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await NotificationRepository(db).delete_all_for_user(current_user.user_id)