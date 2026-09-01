"""responsible members in projects

Revision ID: f6a7b8c9d0e1
Revises: fd847fc58d76
Create Date: 2026-09-01

1. Добавляет роль MEMBER в projectrole — ответственный исполнитель.
   Постановщики остаются OWNER, поэтому существующие связи не трогаем.
2. Новые категории открыты по умолчанию: ответственные работают со всеми
   колонками, пока админ не закроет их точечно. Уже созданные категории
   сохраняют текущие значения, чтобы поведение досок не поехало.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'f6a7b8c9d0e1'
down_revision: Union[str, Sequence[str], None] = 'fd847fc58d76'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    # ALTER TYPE ... ADD VALUE не работает внутри транзакции
    conn.execute(sa.text('COMMIT'))
    conn.execute(sa.text("ALTER TYPE projectrole ADD VALUE IF NOT EXISTS 'MEMBER'"))

    op.alter_column('columns', 'is_user_movable', server_default=sa.true())
    op.alter_column('columns', 'is_user_creatable', server_default=sa.true())


def downgrade() -> None:
    op.alter_column('columns', 'is_user_movable', server_default=sa.false())
    op.alter_column('columns', 'is_user_creatable', server_default=sa.false())
    # Значения enum в PostgreSQL не удаляются; связи MEMBER убираем,
    # иначе они станут бессмысленными строками.
    op.execute("DELETE FROM project_members WHERE role_in_project = 'MEMBER'")
