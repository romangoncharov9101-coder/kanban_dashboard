"""add projects, subprojects and project scoping for columns/cards

Revision ID: b2c3d4e5f6a7
Revises: ca8087082c5f
Create Date: 2026-08-27

Что делает:
  1. Создаёт таблицы projects и project_members (ответственные постановщики).
  2. Заводит проект «Основной» и переносит в него все существующие
     колонки и карточки, чтобы текущая доска не потерялась.
  3. Добавляет columns.project_id и cards.project_id (NOT NULL после бэкфилла).

Вложенность ограничена одним уровнем — это правило живёт в ProjectService,
на уровне БД parent_id просто ссылается на projects.id.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'ca8087082c5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

projectrole = postgresql.ENUM('OWNER', name='projectrole')
# Тип создаём явно ниже; в create_table передаём ссылку без повторного CREATE TYPE,
# иначе Postgres ругается на дубликат.
projectrole_ref = postgresql.ENUM('OWNER', name='projectrole', create_type=False)


def upgrade() -> None:
    bind = op.get_bind()
    projectrole.create(bind, checkfirst=True)

    op.create_table(
        'projects',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('parent_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_archived', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(['parent_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.user_id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_projects_parent_id', 'projects', ['parent_id'])

    op.create_table(
        'project_members',
        sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('role_in_project', projectrole_ref, nullable=False, server_default='OWNER'),
        sa.Column('added_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.user_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('project_id', 'user_id'),
    )
    op.create_index('ix_project_members_user_id', 'project_members', ['user_id'])

    # ── Проект по умолчанию для уже существующей доски ────────────────
    op.execute("""
        INSERT INTO projects (id, name, description, parent_id, position, is_archived, created_at)
        SELECT gen_random_uuid(), 'Основной', 'Создан автоматически при переходе на проекты', NULL, 0, false, now()
        WHERE EXISTS (SELECT 1 FROM columns)
           OR EXISTS (SELECT 1 FROM cards)
    """)

    op.add_column('columns', sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('cards', sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=True))

    op.execute("UPDATE columns SET project_id = (SELECT id FROM projects ORDER BY created_at LIMIT 1)")
    op.execute("""
        UPDATE cards c
        SET project_id = col.project_id
        FROM columns col
        WHERE c.column_id = col.id
    """)

    # Осиротевших строк остаться не должно, но подстрахуемся:
    # без непустой ссылки NOT NULL не встанет.
    op.execute("DELETE FROM columns WHERE project_id IS NULL")
    op.execute("DELETE FROM cards WHERE project_id IS NULL")

    op.alter_column('columns', 'project_id', existing_type=postgresql.UUID(as_uuid=True), nullable=False)
    op.alter_column('cards', 'project_id', existing_type=postgresql.UUID(as_uuid=True), nullable=False)

    op.create_foreign_key('fk_columns_project', 'columns', 'projects', ['project_id'], ['id'], ondelete='CASCADE')
    op.create_foreign_key('fk_cards_project', 'cards', 'projects', ['project_id'], ['id'], ondelete='CASCADE')
    op.create_index('ix_columns_project_id', 'columns', ['project_id'])
    op.create_index('ix_cards_project_id', 'cards', ['project_id'])


def downgrade() -> None:
    op.drop_index('ix_cards_project_id', table_name='cards')
    op.drop_index('ix_columns_project_id', table_name='columns')
    op.drop_constraint('fk_cards_project', 'cards', type_='foreignkey')
    op.drop_constraint('fk_columns_project', 'columns', type_='foreignkey')
    op.drop_column('cards', 'project_id')
    op.drop_column('columns', 'project_id')

    op.drop_index('ix_project_members_user_id', table_name='project_members')
    op.drop_table('project_members')
    op.drop_index('ix_projects_parent_id', table_name='projects')
    op.drop_table('projects')

    projectrole.drop(op.get_bind(), checkfirst=True)
