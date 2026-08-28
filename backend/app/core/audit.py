"""
Файловый журнал действий.

Зачем отдельно от таблицы events:
  - записи в БД чистятся по сроку хранения, а файлы остаются архивом;
  - файл переживает падение и пересоздание базы;
  - его удобно отдать во внешний сборщик логов, не трогая приложение.

Формат — JSON Lines: одна строка = одно событие, файл за сутки.
Такой файл читается и глазами, и `jq`, и любым парсером логов.

    logs/audit/audit-2026-08-27.jsonl
    logs/app/app.log

Запись в файл никогда не должна ронять основной запрос: любая ошибка
ввода-вывода гасится и уходит в обычный лог приложения.
"""
import json
import logging
import logging.handlers
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import get_settings
from app.core.logging import get_logger

settings = get_settings()
logger = get_logger('core.audit')

_audit_logger: logging.Logger | None = None


def _build_logger() -> logging.Logger | None:
    """Ленивая инициализация: каталог создаём при первой записи."""
    if not settings.AUDIT_LOG_ENABLED:
        return None

    log = logging.getLogger('taskboard.audit')
    if log.handlers:
        return log

    try:
        audit_dir = Path(settings.LOG_DIR) / 'audit'
        audit_dir.mkdir(parents=True, exist_ok=True)

        handler = logging.handlers.TimedRotatingFileHandler(
            filename=str(audit_dir / 'audit.jsonl'),
            when='midnight',
            interval=1,
            backupCount=settings.AUDIT_LOG_RETENTION_DAYS,
            encoding='utf-8',
            utc=True,
        )
        # Файл за сутки: audit.jsonl.2026-08-27
        handler.suffix = '%Y-%m-%d'
        # В строке уже готовый JSON — никакого форматирования сверху
        handler.setFormatter(logging.Formatter('%(message)s'))

        log.setLevel(logging.INFO)
        log.addHandler(handler)
        # Не даём записям утечь в общий лог приложения вторым экземпляром
        log.propagate = False
        return log
    except Exception as exc:
        logger.error(f'Не удалось открыть файл журнала действий: {exc}')
        return None


def write_audit_record(record: dict) -> None:
    """
    Пишет одно событие в файловый журнал.

    Ошибки записи не пробрасываются: журнал важен, но он не повод
    отменять действие пользователя, которое уже выполнено.
    """
    global _audit_logger

    if not settings.AUDIT_LOG_ENABLED:
        return

    if _audit_logger is None:
        _audit_logger = _build_logger()
        if _audit_logger is None:
            return

    try:
        payload = {'ts': datetime.now(timezone.utc).isoformat(), **record}
        _audit_logger.info(json.dumps(payload, ensure_ascii=False, default=str))
    except Exception as exc:
        logger.warning(f'Событие не записано в файл журнала: {exc}')
