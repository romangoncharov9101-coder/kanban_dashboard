"""add_priority_field

Revision ID: 75de94fe1f26
Revises: 12e76c92d6bd
Create Date: 2026-03-26 08:44:24.650719

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '75de94fe1f26'
down_revision: Union[str, Sequence[str], None] = '12e76c92d6bd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cardpriority') THEN
                CREATE TYPE cardpriority AS ENUM ('HIGHT', 'MEDIUM', 'LOW');
            END IF;
        END $$;
    """)

    from sqlalchemy.dialects import postgresql
    op.add_column('cards', sa.Column(
        'priority', 
        postgresql.ENUM('HIGHT', 'MEDIUM', 'LOW', name='cardpriority', create_type=False), 
        server_default='LOW', 
        nullable=False
    ))


def downgrade() -> None:
    op.drop_column('cards', 'priority')
    op.execute("DROP TYPE IF EXISTS cardpriority")
