from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.user_repo import UserRepository
from app.repositories.event_repo import EventRepository
from app.repositories.session_repo import SessionRepository
from app.db.schemas import UserLoginRequest, UserRegisterRequest, UserLoginResponse, UserOut

from app.core.sequrity import hash_password, verify_password, sign_session_id, unsign_session_id
from app.manager import manager
from app.core.logging import get_logger

logger = get_logger('services.user')

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.db.models import User

class UserService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = UserRepository(session)
        self.event_repo = EventRepository(session)
        self.session_repo = SessionRepository(session)

    async def register(self, data: UserRegisterRequest) -> tuple[UserLoginResponse, str]:
        existing = await self.repo.get_user_by_username(data.username)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail='Имя пользователя должно быть уникальныи. Такой пользователь уже существует.',
            )
        pw_hash = hash_password(data.password)
        user = await self.repo.create(data.username, password_hash=pw_hash)
        logger.info("User registered: %s (%s)", user.username, user.user_id)
        
        user = await self.repo.set_online(user, True)
        payload = {'user_id': str(user.user_id), 'username': user.username}
        await self.event_repo.create('user_online', payload, str(user.username))
        await manager.publish('user_online', str(user.user_id), payload)

        db_session = await self.session_repo.create(user.user_id)
        signed = sign_session_id(db_session.id)

        return (
            UserLoginResponse(user_id=user.user_id, username=user.username),
            signed
        )

    async def login(self, data: UserLoginRequest) -> tuple[UserLoginResponse, str]:
        user = await self.repo.get_user_by_username(data.username)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Неправильное имя пользователя или пароль.",
            )

        if user.password_hash is None:
            user.password_hash = hash_password(data.password)
            await self.session.flush()
            logger.info("Password set for legacy user: %s", user.username)
        else:
            if not verify_password(data.password, user.password_hash):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Неправильное имя пользователя или пароль.",
                )
            
        user = await self.repo.set_online(user, True)
        payload = {'user_id': str(user.user_id), 'username': user.username}
        await self.event_repo.create('user_online', payload, str(user.username))
        await manager.publish('user_online', str(user.user_id), payload)

        db_session = await self.session_repo.create(user.user_id)
        signed = sign_session_id(db_session.id)

        return (
            UserLoginResponse(user_id=user.user_id, username=user.username),
            signed
        )
    
    async def logout(self, session_id_signed: str, user: 'User') -> None:
        session_id = unsign_session_id(session_id_signed)
        if session_id:
            await self.session_repo.delete(session_id)

        await self.repo.set_online(user, False)
        payload = {'user_id': str(user.user_id), 'username': user.username}
        await self.event_repo.create('user_offline', payload, str(user.username))
        await manager.publish('user_offline', str(user.user_id), payload)
        logger.info("User logged out: %s", user.username)
    
    async def get_online_users(self) -> list[UserOut]:
        users = await self.repo.get_user_online()
        return [UserOut.model_validate(u) for u in users]
    
    async def get_all_users(self) -> list[UserOut]:
        users = await self.repo.get_all_users()
        return [UserOut.model_validate(u) for u in users]
    
    async def search_users(self, query: str) -> list[UserOut]:
        if not query: return []
        users = await self.repo.search_users(query)
        return [UserOut.model_validate(u) for u in users]