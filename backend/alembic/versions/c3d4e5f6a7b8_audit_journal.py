"""audit journal: human readable events

Revision ID: c3d4e5f6a7b8
Revises: 292814d45d15
Create Date: 2026-08-28

Что делает:
  1. Добавляет в eventtype недостающие типы: категории, проекты,
     учётные записи, вход и выход, назначение исполнителей.
  2. Добавляет в events денормализованные названия — имя автора действия,
     заголовок карточки, названия проекта и категории, имя затронутого
     пользователя. Журнал должен оставаться читаемым после удаления
     сущностей, поэтому названия хранятся строками, а не через связи.
  3. Меняет events.card_id с ON DELETE CASCADE на SET NULL: удаление
     карточки больше не стирает историю действий по ней.
  4. Заполняет новые поля по существующим записям, насколько это возможно.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = '292814d45d15'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NEW_EVENT_TYPES = [
    'CARD_ASSIGNED',
    'COLUMN_CREATED', 'COLUMN_UPDATED', 'COLUMN_DELETED',
    'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_DELETED',
    'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED',
    'USER_LOGIN', 'USER_LOGOUT',
]


def upgrade() -> None:
    # ── Новые типы событий ────────────────────────────────────────────
    # ALTER TYPE ... ADD VALUE нельзя выполнять внутри стандартной транзакции.
    # Используем autocommit_block() вместо принудительного COMMIT.
    with op.get_context().autocommit_block():
        for value in NEW_EVENT_TYPES:
            op.execute(sa.text(f"ALTER TYPE eventtype ADD VALUE IF NOT EXISTS '{value}'"))

    # ── Денормализованные названия ────────────────────────────────────
    op.add_column('events', sa.Column('actor_username', sa.String(length=100), nullable=True))
    op.add_column('events', sa.Column('actor_role', sa.String(length=20), nullable=True))
    op.add_column('events', sa.Column('card_title', sa.String(length=200), nullable=True))
    op.add_column('events', sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('events', sa.Column('project_name', sa.String(length=150), nullable=True))
    op.add_column('events', sa.Column('column_name', sa.String(length=100), nullable=True))
    op.add_column('events', sa.Column('target_username', sa.String(length=100), nullable=True))

    op.create_foreign_key(
        'fk_events_project', 'events', 'projects',
        ['project_id'], ['id'], ondelete='SET NULL',
    )
    op.create_index('ix_events_project_id', 'events', ['project_id'])

    # ── Автор действия может быть удалён — событие остаётся ───────────
    op.alter_column('events', 'user_id', existing_type=postgresql.UUID(as_uuid=True), nullable=True)

    # ── Удаление карточки не должно стирать её историю ────────────────
    op.drop_constraint('events_card_id_fkey', 'events', type_='foreignkey')
    op.create_foreign_key(
        'events_card_id_fkey', 'events', 'cards',
        ['card_id'], ['id'], ondelete='SET NULL',
    )

    # ── Заполняем то, что ещё можно восстановить ──────────────────────
    op.execute("""
        UPDATE events e
        SET actor_username = u.username,
            actor_role = u.role::text
        FROM users u
        WHERE e.user_id = u.user_id AND e.actor_username IS NULL
    """)
    op.execute("""
        UPDATE events e
        SET card_title = c.title,
            project_id = c.project_id
        FROM cards c
        WHERE e.card_id = c.id AND e.card_title IS NULL
    """)
    op.execute("""
        UPDATE events e
        SET project_name = p.name
        FROM projects p
        WHERE e.project_id = p.id AND e.project_name IS NULL
    """)


def downgrade() -> None:
    op.drop_constraint('events_card_id_fkey', 'events', type_='foreignkey')
    op.create_foreign_key(
        'events_card_id_fkey', 'events', 'cards',
        ['card_id'], ['id'], ondelete='CASCADE',
    )

    op.execute("DELETE FROM events WHERE user_id IS NULL")
    op.alter_column('events', 'user_id', existing_type=postgresql.UUID(as_uuid=True), nullable=False)

    op.drop_index('ix_events_project_id', table_name='events')
    op.drop_constraint('fk_events_project', 'events', type_='foreignkey')
    for col in ('target_username', 'column_name', 'project_name',
                'project_id', 'card_title', 'actor_role', 'actor_username'):
        op.drop_column('events', col)