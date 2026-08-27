import uuid
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.sequrity import hash_password
from app.db.models import User, UserRole
from app.db.schemas import AdminUserCreate, AdminUserOut, AdminUserUpdate
from app.repositories.session_repo import SessionRepository
from app.repositories.user_repo import UserRepository

logger = get_logger('service.admin')

class AdminService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = UserRepository(session)
        self.session_repo = SessionRepository(session)

    async def list_users(self) -> list[AdminUserOut]:
        users = await self.repo.get_all_users()
        return [AdminUserOut.model_validate(u) for u in users]

    async def create_user(self, data: AdminUserCreate, actor: User) -> AdminUserOut:
        existing = await self.repo.get_user_by_username(data.username)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail='Пользователь с таким логином уже существует.'
            )

        user = await self.repo.create(
            username=data.username,
            password_hash=hash_password(data.password),
            role=UserRole(data.role.value),
            created_by=actor.user_id,
        )
        await self.session.commit()
        logger.info("User created by %s: %s (%s)", actor.username, user.username, user.role.value)
        return AdminUserOut.model_validate(user)

    async def update_user(self, user_id: uuid.UUID, data: AdminUserUpdate, actor: User) -> AdminUserOut:
        user = await self.repo.get_user_by_id(user_id)
        if not user:
            raise HTTPException(status_code=404, detail='Пользователь не найден.')
        updates = {}
        kill_sessions = False

        if data.password is not None:
            updates['password_hash'] = hash_password(data.password)
            kill_sessions = True

        if data.rolw is not None and data.role.value != user.role.value:
            new_role = UserRole(data.role.value)
            if user.role is UserRole.ADMIN and new_role is not UserRole.ADMIN:
                await self._assert_not_last_admin(user)
            updates['role'] = new_role
            kill_sessions = True

        if data.is_active is not None and data.is_active != user.is_active:
            if not data.is_active:
                if user.user_id == actor.user_id:
                    raise HTTPException(status_code=400, detail='Нельзя деактивировать самого себя.')
                await self._assert_not_last_admin(user)
                kill_sessions = True
            updates['is_active'] = data.is_active

        if not updates:
            return AdminUserOut.model_validate(user)
        user = await self.repo.update(user, **updates)
        if kill_sessions:
            await self.session_repo.delete_for_user(user.user_id)
            await self.repo.set_online(user, False)

        await self.session.commit()
        logger.info("User %s updated by %s: %s", user.username, actor.username, list(updates))
        return AdminUserOut.model_validate(user)

    async def deactivate_user(self, user_id: uuid.UUID, actor: User):
        user = await self.repo.get_user_by_id(user_id)
        if not user:
            raise HTTPException(status_code=404, detail='Пользователь не найден.')
        if user.user_id == actor.user_id:
            raise HTTPException(status_code=400, detail='Нельзя удалить самого себя.')
        await self._assert_not_last_admin(user)
        await self.repo.update(user, is_active=False, online=False)
        await self.session_repo.delete_for_user(user.user_id)
        await self.session.commit()
        logger.info("User %s deactivated by %s", user.username, actor.username)

    async def _assert_not_last_admin(self, user: User):
        if user.role is not UserRole.ADMIN:
            return
        remaining = await self.repo.count_admins(exclude_id=user.user_id)
        if remaining == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail='Это последний администратор - операция заблокирована.'
            )
        