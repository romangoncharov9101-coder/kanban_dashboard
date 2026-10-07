"""project managers (руководители проекта)

Revision ID: a1b2c3d4e5f8
Revises: e7f8a9b0c1d2
Create Date: 2026-10-07

Новая роль внутри проекта MANAGER в projectrole. Руководитель — это
назначение в проекте, а не роль пользователя: связи живут в той же
таблице project_members, что постановщики и ответственные.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a1b2c3d4e5f8'
down_revision: Union[str, Sequence[str], None] = 'e7f8a9b0c1d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    # ALTER TYPE ... ADD VALUE нельзя выполнять внутри транзакции
    conn.execute(sa.text('COMMIT'))
    conn.execute(sa.text("ALTER TYPE projectrole ADD VALUE IF NOT EXISTS 'MANAGER'"))


def downgrade() -> None:
    # Значения enum в PostgreSQL не удаляются. Убираем назначения
    # руководителей, чтобы после отката никто не получил лишних прав.
    op.execute("DELETE FROM project_members WHERE role_in_project = 'MANAGER'")