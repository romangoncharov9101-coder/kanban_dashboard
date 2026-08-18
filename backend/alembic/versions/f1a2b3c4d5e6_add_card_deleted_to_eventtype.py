"""add_card_deleted_to_eventtype

Revision ID: f1a2b3c4d5e6
Revises: b9f87196a1f1
Create Date: 2026-08-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'b9f87196a1f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
    # Postgres, so we commit the current alembic transaction first.
    op.execute("COMMIT")
    op.execute("ALTER TYPE eventtype ADD VALUE IF NOT EXISTS 'CARD_DELETED'")


def downgrade() -> None:
    """Downgrade schema."""
    # Postgres doesn't support removing a value from an enum type directly.
    # Rebuild the type without CARD_DELETED.
    op.execute(
        "ALTER TYPE eventtype RENAME TO eventtype_old"
    )
    op.execute(
        "CREATE TYPE eventtype AS ENUM ("
        "'CARD_CREATED', 'CARD_EDITED', 'CARD_MOVED', 'CARD_ARCHIVED', "
        "'CARD_RESTORED', 'COMMENT_ADDED', 'COMMENT_EDITED', "
        "'COMMENT_DELETED', 'ATTACHMENT_ADDED', 'ATTACHMENT_DELETED')"
    )
    op.execute(
        "ALTER TABLE events ALTER COLUMN event_type TYPE eventtype "
        "USING event_type::text::eventtype"
    )
    op.execute("DROP TYPE eventtype_old")