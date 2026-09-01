"""add card status

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-09-01

Добавляет стадию работы над задачей: не начата, взята в работу,
проверка, доработка, готово. Существующие задачи получают
«не начата», кроме архивных — их считаем завершёнными.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

cardstatus = postgresql.ENUM(
    'NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'REWORK', 'DONE',
    name='cardstatus',
)


def upgrade() -> None:
    bind = op.get_bind()
    cardstatus.create(bind, checkfirst=True)

    op.add_column(
        'cards',
        sa.Column(
            'status',
            postgresql.ENUM(
                'NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'REWORK', 'DONE',
                name='cardstatus', create_type=False,
            ),
            nullable=False,
            server_default='NOT_STARTED',
        ),
    )
    op.create_index('ix_cards_status', 'cards', ['status'])

    # Явное приведение строки к типу ENUM (DONE::cardstatus)
    op.execute("UPDATE cards SET status = 'DONE'::cardstatus WHERE is_archived = true")

    # Новый тип события для журнала действий через autocommit_block()
    with op.get_context().autocommit_block():
        op.execute(sa.text("ALTER TYPE eventtype ADD VALUE IF NOT EXISTS 'CARD_STATUS_CHANGED'"))


def downgrade() -> None:
    op.drop_index('ix_cards_status', table_name='cards')
    op.drop_column('cards', 'status')
    cardstatus.drop(op.get_bind(), checkfirst=True)