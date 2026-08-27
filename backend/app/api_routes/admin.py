import uuid
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_admin
from app.db.models import User
from app.db.schemas import AdminUserCreate, AdminUserOut, AdminUserUpdate
from app.db.session import get_db
from app.services.admin_service import AdminService

router = APIRouter(prefix='/admin', tags=['admin'])


@router.get('/users', response_model=list[AdminUserOut])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return await AdminService(db).list_users()


@router.post('/users', response_model=AdminUserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: AdminUserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return await AdminService(db).create_user(body, current_user)


@router.patch('/users/{user_id}', response_model=AdminUserOut)
async def update_user(
    user_id: uuid.UUID,
    body: AdminUserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return await AdminService(db).update_user(user_id, body, current_user)


@router.delete('/users/{user_id}', status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Мягкое удаление: аккаунт деактивируется, сессии сбрасываются."""
    await AdminService(db).deactivate_user(user_id, current_user)
