from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.user_service import UserService
from app.db.schemas import UserLoginResponse, UserLoginRequest, UserOut

router = APIRouter(prefix='/users', tags=['users'])

@router.get('', response_model=list[UserOut])
async def all_users(db: AsyncSession = Depends(get_db)):
    return await UserService(db).get_all_users()

@router.post('/login', response_model=UserLoginResponse, status_code=status.HTTP_200_OK)
async def login(body: UserLoginRequest, db: AsyncSession = Depends(get_db)):
    return await UserService(db).login(body)

@router.get('/online', response_model=list[UserOut])
async def online_users(db: AsyncSession = Depends(get_db)):
    return await UserService(db).get_online_users()