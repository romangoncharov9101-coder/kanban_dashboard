"""project manager is an assignment, not a user role

Revision ID: b2c3d4e5f6a9
Revises: a1b2c3d4e5f8
Create Date: 2026-10-07

Руководитель проекта теперь только назначение в проекте
(project_members.role_in_project = 'MANAGER'), отдельной роли пользователя
нет. Если на базе уже успела отработать прежняя версия миграции
a1b2c3d4e5f8 и кому-то выдали роль PROJECT_MANAGER, переводим таких
пользователей в исполнители. Их назначения руководителями проектов
сохраняются — права руководителя они получают именно оттуда.

На свежей базе значения PROJECT_MANAGER в enum нет, поэтому сравниваем
как текст: иначе PostgreSQL отверг бы неизвестное значение enum.
Само значение из типа userrole PostgreSQL удалить не позволяет — оно
остаётся неиспользуемым.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'b2c3d4e5f6a9'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE users SET role = 'USER' WHERE role::text = 'PROJECT_MANAGER'")


def downgrade() -> None:
    # Прежнюю роль восстановить нельзя и не нужно: права руководителя
    # определяются назначением в проекте.
    pass