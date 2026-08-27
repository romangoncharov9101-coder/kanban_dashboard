import uuid
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_admin
from app.db.models import User
from app.db.schemas import ProjectCreate, ProjectOut, ProjectUpdate
from app.db.session import get_db
from app.services.project_service import ProjectService

router = APIRouter(prefix='/projects', tags=['projects'])


@router.get('', response_model=list[ProjectOut])
async def list_projects(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Дерево проектов, отфильтрованное под роль текущего пользователя."""
    return await ProjectService(db).get_tree(current_user)


@router.get('/{project_id}', response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await ProjectService(db).get_one(project_id, current_user)


@router.post('', response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(body: ProjectCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_admin)):
    """Проекты и подпроекты создаёт только администратор."""
    return await ProjectService(db).create(body, current_user)


@router.patch('/{project_id}', response_model=ProjectOut)
async def update_project(project_id: uuid.UUID, body: ProjectUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_admin)):
    return await ProjectService(db).update(project_id, body, current_user)


@router.delete('/{project_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_admin)):
    await ProjectService(db).delete(project_id, current_user)
