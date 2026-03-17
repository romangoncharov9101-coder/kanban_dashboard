from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.user_repo import UserRepository
from app.repositories.event_repo import EventRepository
from app.db.schemas import UserLoginRequest, UserLoginResponse, UserOut
from app.manager import manager
from app.core.logging import get_logger

logger = get_logger('services.user')

class UserService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = UserRepository(session)
        self.event_repo = EventRepository(session)

    async def login(self, data: UserLoginRequest) -> UserLoginResponse:
        user = await self.repo.get_user_by_username(data.username)
        if not user:
            user = await self.repo.create(data.username)
            logger.info(f'New user created: {user.username} ({user.user_id})')

        user = await self.repo.set_online(user, True)
        payload = {'user_id': str(user.user_id), 'username': user.username}
        await self.event_repo.create('user_online', payload, str(user.user_id))
        await manager.publish('user_online', str(user.user_id), payload)
 
        return UserLoginResponse(
            user_id=user.user_id,
            username=user.username,
            token=str(user.user_id),
        )
    
    async def get_online_users(self) -> list[UserOut]:
        users = await self.repo.get_user_online()
        return [UserOut.model_validate(u) for u in users]
    
    async def get_all_users(self) -> list[UserOut]:
        users = await self.repo.get_all_users()
        return [UserOut.model_validate(u) for u in users]