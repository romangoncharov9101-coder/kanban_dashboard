"""allow executors to create personal tasks in selected columns

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-09-01

Добавляет columns.is_user_creatable — разрешение исполнителю заводить
собственные задачи в этой категории. По умолчанию выключено у всех:
поведение существующих досок не меняется.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'columns',
        sa.Column('is_user_creatable', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('columns', 'is_user_creatable')
