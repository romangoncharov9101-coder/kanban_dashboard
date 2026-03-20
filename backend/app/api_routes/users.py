from fastapi import APIRouter, Depends, status, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.core.config import get_settings
from app.core.deps import get_current_user
from app.services.user_service import UserService
from app.db.models import User
from app.db.schemas import UserLoginResponse, UserLoginRequest, UserOut, UserRegisterRequest

settings = get_settings()
router = APIRouter(prefix='/users', tags=['users'])

def _set_session_cookie(response: Response, signed_value: str) -> None:
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=signed_value,
        httponly=True,
        secure=False,       # True в продакшен
        samesite='lax',
        max_age=settings.SESSION_TTL_SECONDS,
        path='/'
    )

@router.post('/register', response_model=UserLoginResponse, status_code=status.HTTP_201_CREATED)
async def register(body: UserRegisterRequest, response: Response, db: AsyncSession = Depends(get_db)):
    login_resp, signed = await UserService(db).register(body)
    _set_session_cookie(response, signed)
    return login_resp

@router.post('/login', response_model=UserLoginResponse, status_code=status.HTTP_200_OK)
async def login(body: UserLoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    login_resp, signed = await UserService(db).login(body)
    _set_session_cookie(response, signed)
    return login_resp

@router.post('/logout', status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    cookie_value = request.cookies.get(settings.SESSION_COOKIE_NAME, '')
    await UserService(db).logout(cookie_value, current_user)
    response.delete_cookie(key=settings.SESSION_COOKIE_NAME, path='/')

@router.get('/me', response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return UserOut.model_validate(current_user)

@router.get('', response_model=list[UserOut])
async def all_users(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await UserService(db).get_all_users()

@router.get('/online', response_model=list[UserOut])
async def online_users(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await UserService(db).get_online_users()

@router.get('/search', response_model=list[UserOut])
async def search_users(q: str = '', db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await UserService(db).search_users(q)