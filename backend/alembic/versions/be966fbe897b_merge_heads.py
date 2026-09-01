"""merge heads

Revision ID: be966fbe897b
Revises: ae4e6849c889, d4e5f6a7b8c9
Create Date: 2026-09-01 08:54:28.955132

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'be966fbe897b'
down_revision: Union[str, Sequence[str], None] = ('ae4e6849c889', 'd4e5f6a7b8c9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
