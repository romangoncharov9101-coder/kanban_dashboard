"""add user roles, multiple assignees and column move permission

Revision ID: ca8087082c5f
Revises: f1a2b3c4d5e6
Create Date: 2026-08-26

Что делает:
  1. Добавляет enum userrole и поля role / is_active / created_at / created_by в users.
  2. Делает password_hash обязательным (аккаунты без пароля больше не допускаются).
  3. Создаёт таблицу card_assignees и переносит в неё текущее значение cards.assigned_to.
  4. Удаляет колонку cards.assigned_to.
  5. Добавляет columns.is_user_movable — разрешение для роли USER
     перетаскивать свои задачи в эту категорию.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'ca8087082c5f'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


userrole = postgresql.ENUM('ADMIN', 'TEAM_LEAD', 'USER', name='userrole')


def upgrade() -> None:
    bind = op.get_bind()
    userrole.create(bind, checkfirst=True)

    # ── users ────────────────────────────────────────────────────────────
    op.add_column(
        'users',
        sa.Column('role', userrole, nullable=False, server_default='USER'),
    )
    op.add_column(
        'users',
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        'users',
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
    )
    op.add_column(
        'users',
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        'fk_users_created_by', 'users', 'users',
        ['created_by'], ['user_id'], ondelete='SET NULL',
    )
    op.create_index('ix_users_role', 'users', ['role'])

    # Аккаунты без пароля превращаем в деактивированные вместо удаления,
    # чтобы не потерять связанные карточки и комментарии.
    op.execute("UPDATE users SET is_active = false WHERE password_hash IS NULL")
    op.execute("UPDATE users SET password_hash = '!' WHERE password_hash IS NULL")
    op.alter_column('users', 'password_hash', existing_type=sa.String(255), nullable=False)

    # ── card_assignees ───────────────────────────────────────────────────
    op.create_table(
        'card_assignees',
        sa.Column('card_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('assigned_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['card_id'], ['cards.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.user_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('card_id', 'user_id'),
    )
    op.create_index('ix_card_assignees_user_id', 'card_assignees', ['user_id'])

    # Перенос единственного исполнителя в новую таблицу
    op.execute("""
        INSERT INTO card_assignees (card_id, user_id, assigned_at)
        SELECT id, assigned_to, now()
        FROM cards
        WHERE assigned_to IS NOT NULL
    """)

    op.drop_column('cards', 'assigned_to')

    # ── columns ──────────────────────────────────────────────────────────
    op.add_column(
        'columns',
        sa.Column('is_user_movable', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('columns', 'is_user_movable')

    op.add_column(
        'cards',
        sa.Column('assigned_to', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        'cards_assigned_to_fkey', 'cards', 'users',
        ['assigned_to'], ['user_id'], ondelete='SET NULL',
    )
    # Обратно переносим только первого исполнителя — остальные теряются.
    op.execute("""
        UPDATE cards c
        SET assigned_to = sub.user_id
        FROM (
            SELECT DISTINCT ON (card_id) card_id, user_id
            FROM card_assignees
            ORDER BY card_id, assigned_at
        ) AS sub
        WHERE c.id = sub.card_id
    """)

    op.drop_index('ix_card_assignees_user_id', table_name='card_assignees')
    op.drop_table('card_assignees')

    op.alter_column('users', 'password_hash', existing_type=sa.String(255), nullable=True)
    op.drop_index('ix_users_role', table_name='users')
    op.drop_constraint('fk_users_created_by', 'users', type_='foreignkey')
    op.drop_column('users', 'created_by')
    op.drop_column('users', 'created_at')
    op.drop_column('users', 'is_active')
    op.drop_column('users', 'role')

    userrole.drop(op.get_bind(), checkfirst=True)
