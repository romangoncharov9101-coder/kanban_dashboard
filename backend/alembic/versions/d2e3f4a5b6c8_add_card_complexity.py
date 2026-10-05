"""add card complexity

Revision ID: d2e3f4a5b6c8
Revises: c1a2b3d4e5f7
Create Date: 2026-10-05

Добавляет сложность (трудоёмкость) задачи: элементарная, простая,
средняя, сложная, экспертная. Поле необязательное — существующие
задачи остаются «не оценена» (NULL): оценить их задним числом
честно нельзя, а значение по умолчанию исказило бы сводку нагрузки.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd2e3f4a5b6c8'
down_revision: Union[str, Sequence[str], None] = 'c1a2b3d4e5f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COMPLEXITY_VALUES = ('TRIVIAL', 'EASY', 'MEDIUM', 'HARD', 'EXPERT')

cardcomplexity = postgresql.ENUM(*COMPLEXITY_VALUES, name='cardcomplexity')


def upgrade() -> None:
    cardcomplexity.create(op.get_bind(), checkfirst=True)

    op.add_column(
        'cards',
        sa.Column(
            'complexity',
            postgresql.ENUM(*COMPLEXITY_VALUES, name='cardcomplexity', create_type=False),
            nullable=True,
        ),
    )
    op.create_index('ix_cards_complexity', 'cards', ['complexity'])


def downgrade() -> None:
    op.drop_index('ix_cards_complexity', table_name='cards')
    op.drop_column('cards', 'complexity')
    cardcomplexity.drop(op.get_bind(), checkfirst=True)