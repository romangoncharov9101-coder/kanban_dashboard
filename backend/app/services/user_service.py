from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.user_repo import UserRepository
from app.repositories.event_repo import EventRepository
from app.repositories.session_repo import SessionRepository
from app.db.models import EventType
from app.db.schemas import UserLoginRequest, UserLoginResponse, UserOut

from app.core.sequrity import verify_password, sign_session_id, unsign_session_id
from app.manager import manager
from app.core.logging import get_logger

logger = get_logger('services.user')

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.db.models import User


class UserService:
    """
    Аутентификация. Регистрации нет: пользователей заводит администратор
    (см. AdminService), а сам администратор создаётся из .env при старте.
    """

    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = UserRepository(session)
        self.session_repo = SessionRepository(session)
        self.event_repo = EventRepository(session)

    async def login(self, data: UserLoginRequest) -> tuple[UserLoginResponse, str]:
        user = await self.repo.get_user_by_username(data.username)

        # Одинаковый ответ для несуществующего логина и неверного пароля,
        # чтобы нельзя было перебором узнать список существующих аккаунтов.
        invalid = HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неправильное имя пользователя или пароль.",
        )

        if not user or not user.password_hash:
            raise invalid

        if not verify_password(data.password, user.password_hash):
            logger.warning("Failed login attempt for user: %s", data.username)
            raise invalid

        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Учётная запись деактивирована. Обратитесь к администратору.",
            )

        user = await self.repo.set_online(user, True)
        payload = {'user_id': str(user.user_id), 'username': user.username}
        await manager.publish('user_online', str(user.user_id), payload)

        db_session = await self.session_repo.create(user.user_id)
        signed = sign_session_id(db_session.id)

        await self.event_repo.create(
            event_type=EventType.USER_LOGIN,
            message=f'Вошёл в систему',
            actor=user,
        )
        logger.info("User logged in: %s (%s)", user.username, user.role.value)

        return (
            UserLoginResponse(user_id=user.user_id, username=user.username, role=user.role),
            signed
        )

    async def logout(self, session_id_signed: str, user: 'User') -> None:
        session_id = unsign_session_id(session_id_signed)
        if session_id:
            await self.session_repo.delete(session_id)

        await self.repo.set_online(user, False)
        payload = {'user_id': str(user.user_id), 'username': user.username}
        await manager.publish('user_offline', str(user.user_id), payload)
        await self.event_repo.create(
            event_type=EventType.USER_LOGOUT,
            message='Вышел из системы',
            actor=user,
        )
        logger.info("User logged out: %s", user.username)

    async def get_online_users(self) -> list[UserOut]:
        users = await self.repo.get_user_online()
        return [UserOut.model_validate(u) for u in users]

    async def get_all_users(self) -> list[UserOut]:
        users = await self.repo.get_all_users()
        return [UserOut.model_validate(u) for u in users]

    async def search_users(self, query: str) -> list[UserOut]:
        if not query:
            return []
        users = await self.repo.search_users(query)
        return [UserOut.model_validate(u) for u in users]
