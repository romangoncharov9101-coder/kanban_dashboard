"""add PAUSED card status

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-09-01

Добавляет стадию «пауза»: работа начата, но приостановлена.
Существующие задачи не трогаем — статус проставляется вручную.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b8c9d0e1f2a3'
down_revision: Union[str, Sequence[str], None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE нельзя выполнять внутри транзакции
    conn = op.get_bind()
    conn.execute(sa.text('COMMIT'))
    conn.execute(sa.text("ALTER TYPE cardstatus ADD VALUE IF NOT EXISTS 'PAUSED'"))


def downgrade() -> None:
    op.execute("UPDATE cards SET status = 'IN_PROGRESS' WHERE status = 'PAUSED'")