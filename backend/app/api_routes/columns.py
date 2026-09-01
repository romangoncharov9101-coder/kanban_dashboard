import uuid
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.column_service import ColumnService
from app.db.schemas import ColumnCreate, ColumnUpdate, ColumnOut
from app.core.deps import get_current_user, require_manager
from app.db.models import User

router = APIRouter(prefix='/columns', tags=['columns'])


@router.get('', response_model=list[ColumnOut])
async def list_columns(
    project_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await ColumnService(db).get_all(project_id, viewer=current_user)


@router.post('', response_model=ColumnOut, status_code=status.HTTP_201_CREATED)
async def create_column(body: ColumnCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_manager)):
    return await ColumnService(db).create(body, current_user)


@router.put('/{column_id}', response_model=ColumnOut)
async def update_column(column_id: uuid.UUID, body: ColumnUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_manager)):
    return await ColumnService(db).update(column_id, body, current_user)


@router.delete('/{column_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_column(column_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_manager)):
    await ColumnService(db).delete(column_id, current_user)