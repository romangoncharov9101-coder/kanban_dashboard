"""Создание администратора из .env файла при старте приложения."""
from sqlalchemy import select

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.sequrity import hash_password
from app.db.models import User, UserRole
from app.db.session import AsyncSessionLocale

logger = get_logger('core.bootstrap')
settings = get_settings()

async def ensure_admin_exists():
    if not settings.ADMIN_PASSWORD:
        logger.error(
            'ADMIN_PASSWORD не задан в .env — администратор не создан. '
            'Войти в систему будет невозможно.'
        )
        return

    if len(settings.ADMIN_PASSWORD) < 6:
        logger.error('ADMIN_PASSWORD короче 6 символов — администратор не создан.')
        return

    username = settings.ADMIN_USERNAME.strip()

    async with AsyncSessionLocale() as db:
        result = await db.execute(select(User).where(User.username == username))
        admin = result.scalar_one_or_none()

        if admin is None:
            admin = User(
                username=username,
                password_hash=hash_password(settings.ADMIN_PASSWORD),
                role=UserRole.ADMIN,
                is_active=True,
                online=False,
            )
            db.add(admin)
            await db.commit()
            logger.info(f"Администратор '{username}' создан из .env")
            return

        changed = []

        # Учётка админа не должна остаться заблокированной или пониженной в правах.
        if admin.role is not UserRole.ADMIN:
            admin.role = UserRole.ADMIN
            changed.append('role')
        if not admin.is_active:
            admin.is_active = True
            changed.append('is_active')
        if settings.ADMIN_SYNC_PASSWORD_ON_START:
            admin.password_hash = hash_password(settings.ADMIN_PASSWORD)
            changed.append('password')

        if changed:
            await db.commit()
            logger.info(f"Администратор '{username}' синхронизирован из .env: {', '.join(changed)}")
        else:
            logger.info(f"Администратор '{username}' уже существует")