"""complexity: S / M / L / XL

Revision ID: e7f8a9b0c1d2
Revises: d2e3f4a5b6c8
Create Date: 2026-10-07

Заменяет пять уровней сложности (TRIVIAL…EXPERT) на четыре размера:
  S  — небольшая правка, до нескольких часов
  M  — стандартная задача на 1–2 дня
  L  — сложная задача на 3–5 дней
  XL — отдельный этап проекта, требует декомпозиции

Уже проставленные оценки переносятся по смыслу:
  TRIVIAL, EASY → S;  MEDIUM → M;  HARD → L;  EXPERT → XL.
Неоценённые задачи (NULL) остаются неоценёнными.

ВАЖНО: down_revision должен указывать на ЕДИНСТВЕННУЮ текущую голову
цепочки на сервере. Проверьте её командой `alembic heads` и при
необходимости поправьте строку down_revision ниже.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e7f8a9b0c1d2'
down_revision: Union[str, Sequence[str], None] = 'd2e3f4a5b6c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


NEW_VALUES = ('S', 'M', 'L', 'XL')
OLD_VALUES = ('TRIVIAL', 'EASY', 'MEDIUM', 'HARD', 'EXPERT')

UPGRADE_MAP = {
    'TRIVIAL': 'S',
    'EASY': 'S',
    'MEDIUM': 'M',
    'HARD': 'L',
    'EXPERT': 'XL',
}
DOWNGRADE_MAP = {
    'S': 'EASY',
    'M': 'MEDIUM',
    'L': 'HARD',
    'XL': 'EXPERT',
}


def _current_labels() -> list[str]:
    rows = op.get_bind().execute(sa.text(
        "SELECT e.enumlabel FROM pg_type t "
        "JOIN pg_enum e ON e.enumtypid = t.oid "
        "WHERE t.typname = 'cardcomplexity' ORDER BY e.enumsortorder"
    ))
    return [r[0] for r in rows]


def _swap_enum(new_values: tuple[str, ...], mapping: dict[str, str]) -> None:
    """
    Пересоздаёт тип cardcomplexity с новым набором значений.

    ALTER TYPE ... ADD VALUE здесь не подходит: старые значения нужно
    удалить, а PostgreSQL удалять значения из enum не умеет. Поэтому:
    старый тип переименовываем, создаём новый под прежним именем,
    переводим колонку с пересчётом значений и удаляем старый тип.
    Индекс ix_cards_complexity PostgreSQL перестраивает сам.
    """
    case = ' '.join(f"WHEN '{old}' THEN '{new}'" for old, new in mapping.items())
    labels = ', '.join(f"'{v}'" for v in new_values)

    op.execute('ALTER TYPE cardcomplexity RENAME TO cardcomplexity_old')
    op.execute(f'CREATE TYPE cardcomplexity AS ENUM ({labels})')
    op.execute(
        'ALTER TABLE cards ALTER COLUMN complexity TYPE cardcomplexity '
        f'USING (CASE complexity::text {case} END)::cardcomplexity'
    )
    op.execute('DROP TYPE cardcomplexity_old')


def upgrade() -> None:
    # Повторный запуск на уже переведённой базе ничего не ломает
    if _current_labels() == list(NEW_VALUES):
        return
    _swap_enum(NEW_VALUES, UPGRADE_MAP)


def downgrade() -> None:
    if _current_labels() == list(OLD_VALUES):
        return
    _swap_enum(OLD_VALUES, DOWNGRADE_MAP)