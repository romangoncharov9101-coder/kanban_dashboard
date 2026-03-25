import uuid
from fastapi import APIRouter, Depends, Query, UploadFile, status, Response
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.card_service import CardService
from app.services.column_service import ColumnService
from app.services.user_service import UserService
from app.core.deps import get_current_user
from app.db.models import User

router = APIRouter(prefix='/board', tags=['board'])

@router.get('/init')
async def get_board_init(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    columns = await ColumnService(db).get_all()
    cards = await CardService(db).get_all()
    online_users = await UserService(db).get_online_users()

    return {
        'columns': columns,
        'cards': cards,
        'online_users': online_users
    }