from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.sequrity import unsign_session_id
from app.db.session import get_db, AsyncSessionLocale
from app.db.models import User, UserRole
from app.repositories.session_repo import SessionRepository

settings = get_settings()

async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    """
    Dependency для защищённых REST-эндпоинтов.

    Поток:
      1. Читаем SESSION_COOKIE_NAME из request.cookies
      2. Верифицируем HMAC-подпись через unsign_session_id
      3. SELECT sessions + JOIN users WHERE id = session_id AND expires_at > now
      4. Проверяем, что учётка не деактивирована
      5. Возвращаем User

    Raises 401 если cookie отсутствует, подпись невалидна или сессия истекла.
    Raises 403 если учётная запись деактивирована администратором.
    """
    cookie_value: str | None = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not cookie_value:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Не авторизирован.",
        )

    session_id = unsign_session_id(cookie_value)
    if session_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Неправильная сессия.',
        )

    repo = SessionRepository(db)
    db_session = await repo.get_valid(session_id)
    if db_session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Сессия истекла или не найдена.',
        )

    user = db_session.user
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Учётная запись деактивирована. Обратитесь к администратору.',
        )
    return user

def require_roles(*roles: UserRole):
    """
    Фабрика зависимостей для проверки роли.

    Пример:
        @router.post('', dependencies=[Depends(require_admin)])
        async def create_user(...): ...

    Или когда нужен сам объект пользователя:
        current_user: User = Depends(require_manager)
    """
    allowed = set(roles)

    async def _check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='Недостаточно прав для этого действия.',
            )
        return current_user

    return _check

# Только администратор: управление пользователями.
require_admin = require_roles(UserRole.ADMIN)

# Администратор или тим-лидер: управление категориями и задачами.
require_manager = require_roles(UserRole.ADMIN, UserRole.TEAM_LEAD)

async def get_current_user_ws(ws) -> User | None:
    cookie_header: str = ws.headers.get('cookie', '')
    cookie_value: str | None = _parse_cookie(cookie_header, settings.SESSION_COOKIE_NAME)
    if not cookie_value:
        return None

    session_id = unsign_session_id(cookie_value)
    if session_id is None:
        return None

    async with AsyncSessionLocale() as db:
        repo = SessionRepository(db)
        db_session = await repo.get_valid(session_id)
        if db_session is None or not db_session.user.is_active:
            return None
        return db_session.user

async def get_current_user_optional(
        request: Request,
        db: AsyncSession = Depends(get_db)
) -> User | None:
    cookie_value: str | None = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not cookie_value:
        return None
    session_id = unsign_session_id(cookie_value)
    if session_id is None:
        return None
    repo = SessionRepository(db)
    db_session = await repo.get_valid(session_id)
    if db_session is None or not db_session.user.is_active:
        return None
    return db_session.user

def _parse_cookie(cookie_header: str, name: str) -> str | None:
    for part in cookie_header.split(';'):
        part = part.strip()
        if '=' in part:
            k, _, v = part.partition('=')
            if k.strip() == name:
                return v.strip()
    return None
