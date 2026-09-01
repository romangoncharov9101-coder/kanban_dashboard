"""merge heads

Revision ID: fd847fc58d76
Revises: be966fbe897b, e5f6a7b8c9d0
Create Date: 2026-09-01 09:17:10.920439

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fd847fc58d76'
down_revision: Union[str, Sequence[str], None] = ('be966fbe897b', 'e5f6a7b8c9d0')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
