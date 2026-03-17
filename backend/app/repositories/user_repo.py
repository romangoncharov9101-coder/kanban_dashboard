from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import User
import uuid

class UserRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_all_users(self) -> list[User]:
        result = await self.session.execute(
            select(User)
        )

        return list(result.scalars().all())

    async def get_user_by_username(self, username: str) -> User | None:
        result = await self.session.execute(
            select(User).where(User.username == username)
        )

        return result.scalar_one_or_none()
    
    async def get_user_by_id(self, user_id: uuid.UUID) -> User | None:
        result = await self.session.execute(
            select(User).where(User.user_id == user_id)
        )

        return result.scalar_one_or_none()
    
    async def get_user_online(self) -> list[User]:
        result = await self.session.execute(
            select(User).where(User.online == True)
        )

        return list(result.scalars().all())
    
    async def create(self, username: str) -> str:
        user = User(user_id = uuid.uuid4(), username=username, online=False)
        self.session.add(user)
        await self.session.flush()
        await self.session.refresh(user)
        return user
    
    async def set_online(self, user: User, online: bool) -> User:
        user.online = online
        await self.session.flush()
        await self.session.refresh(user)
        return user

    