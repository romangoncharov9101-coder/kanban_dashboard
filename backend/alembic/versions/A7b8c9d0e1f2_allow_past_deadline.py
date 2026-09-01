"""allow past deadlines

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-09-01

Снимает check_deadline_future. Ограничение мешало редактировать
просроченную задачу: клиент отправлял обратно уже истёкший дедлайн,
и запись отклонялась. Просрочка теперь только показывается на карточке.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, Sequence[str], None] = 'f6a7b8c9d0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('ALTER TABLE cards DROP CONSTRAINT IF EXISTS check_deadline_future')


def downgrade() -> None:
    # Записи с дедлайном раньше создания могли появиться, пока
    # ограничения не было — иначе восстановление упадёт.
    op.execute('UPDATE cards SET deadline = NULL WHERE deadline < created_at')
    op.execute(
        'ALTER TABLE cards ADD CONSTRAINT check_deadline_future '
        'CHECK (deadline >= created_at)'
    )