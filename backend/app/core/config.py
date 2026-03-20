from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
ENV_FILE = ROOT_DIR / ".env"

class Settings(BaseSettings):
    """
    Централизованные настройки сервиса.

    Все поля могут быть переопределены через переменные окружения
    или .env файл. Имена переменных нечувствительны к регистру.
    """
    model_config = SettingsConfigDict(
          env_file=str(ENV_FILE),
          env_file_encoding="utf-8",
          case_sensitive=False,
    )

    DATABASE_URL: str = "postgresql+asyncpg://taskdash:taskdash@localhost:5432/taskdashboard"
    CORS_ORIGINS: str = "http://localhost:5500,http://127.0.0.1:5500"
    LOG_LEVEL: str = "INFO"
    EVENT_CLEANUP_INTERVAL: int = 300
    EVENT_MAX_AGE_SECONDS: int = 86400

    SESSION_SECRET_KEY: str = "CHANGE_ME_in_production_use_random_32+_chars"
    SESSION_TTL_SECONDS: int = 60 * 60 * 24
    SESSION_COOKIE_NAME: str = "tb_session"
    EXPOSE_DOCS: bool = True

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(',')]

@lru_cache
def get_settings() -> Settings:
    return Settings()
