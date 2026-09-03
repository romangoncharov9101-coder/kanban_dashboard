"""add sequential numbers to cards and columns

Revision ID: c1a2b3d4e5f7
Revises: 58c46b363eef
Create Date: 2026-09-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'c1a2b3d4e5f7'
down_revision: Union[str, Sequence[str], None] = '58c46b363eef'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute('CREATE SEQUENCE IF NOT EXISTS card_number_seq')
    op.execute('CREATE SEQUENCE IF NOT EXISTS column_number_seq')

    op.add_column('cards', sa.Column('number', sa.Integer(), nullable=True))
    op.add_column('columns', sa.Column('number', sa.Integer(), nullable=True))

    op.execute("""
        WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
            FROM cards
        )
        UPDATE cards SET number = numbered.rn
        FROM numbered WHERE cards.id = numbered.id
    """)
    op.execute("""
        WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY project_id, position, id) AS rn
            FROM columns
        )
        UPDATE columns SET number = numbered.rn
        FROM numbered WHERE columns.id = numbered.id
    """)

    op.execute("SELECT setval('card_number_seq', COALESCE((SELECT MAX(number) FROM cards), 0) + 1, false)")
    op.execute("SELECT setval('column_number_seq', COALESCE((SELECT MAX(number) FROM columns), 0) + 1, false)")

    op.alter_column('cards', 'number', nullable=False,
                     server_default=sa.text("nextval('card_number_seq')"))
    op.alter_column('columns', 'number', nullable=False,
                     server_default=sa.text("nextval('column_number_seq')"))

    op.create_unique_constraint('uq_cards_number', 'cards', ['number'])
    op.create_unique_constraint('uq_columns_number', 'columns', ['number'])
    op.create_index('ix_cards_number', 'cards', ['number'])
    op.create_index('ix_columns_number', 'columns', ['number'])

    op.execute("ALTER SEQUENCE card_number_seq OWNED BY cards.number")
    op.execute("ALTER SEQUENCE column_number_seq OWNED BY columns.number")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_columns_number', table_name='columns')
    op.drop_index('ix_cards_number', table_name='cards')
    op.drop_constraint('uq_columns_number', 'columns', type_='unique')
    op.drop_constraint('uq_cards_number', 'cards', type_='unique')
    op.drop_column('columns', 'number')
    op.drop_column('cards', 'number')
    op.execute('DROP SEQUENCE IF EXISTS column_number_seq')
    op.execute('DROP SEQUENCE IF EXISTS card_number_seq')