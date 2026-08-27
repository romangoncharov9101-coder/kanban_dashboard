import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import User, UserRole


class UserRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_all_users(self) -> list[User]:
        result = await self.session.execute(
            select(User).order_by(User.role, User.username)
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

    async def get_users_by_ids(self, user_ids: list[uuid.UUID]) -> list[User]:
        if not user_ids:
            return []
        result = await self.session.execute(
            select(User).where(User.user_id.in_(user_ids))
        )
        return list(result.scalars().all())

    async def get_user_online(self) -> list[User]:
        result = await self.session.execute(
            select(User).where(User.online == True)  # noqa: E712
        )
        return list(result.scalars().all())

    async def get_ids_by_roles(self, *roles: UserRole) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(User.user_id).where(User.role.in_(roles), User.is_active == True)  # noqa: E712
        )
        return list(result.scalars().all())

    async def create(
        self,
        username: str,
        password_hash: str,
        role: UserRole = UserRole.USER,
        created_by: uuid.UUID | None = None,
    ) -> User:
        user = User(
            user_id=uuid.uuid4(),
            username=username,
            online=False,
            password_hash=password_hash,
            role=role,
            is_active=True,
            created_by=created_by,
        )
        self.session.add(user)
        await self.session.flush()
        await self.session.refresh(user)
        return user

    async def update(self, user: User, **kwargs) -> User:
        for k, v in kwargs.items():
            setattr(user, k, v)
        await self.session.flush()
        await self.session.refresh(user)
        return user

    async def delete(self, user: User) -> None:
        await self.session.delete(user)
        await self.session.flush()

    async def set_online(self, user: User, online: bool) -> User:
        user.online = online
        await self.session.flush()
        await self.session.refresh(user)
        return user

    async def count_admins(self, exclude_id: uuid.UUID | None = None) -> int:
        q = select(User).where(User.role == UserRole.ADMIN, User.is_active == True)  # noqa: E712
        if exclude_id:
            q = q.where(User.user_id != exclude_id)
        result = await self.session.execute(q)
        return len(list(result.scalars().all()))

    async def search_users(self, query: str, limit: int = 5, active_only: bool = True) -> list[User]:
        q = select(User).where(User.username.ilike(f'%{query}%'))
        if active_only:
            q = q.where(User.is_active == True)  # noqa: E712
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())
