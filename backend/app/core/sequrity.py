import uuid
from itsdangerous import URLSafeSerializer, BadSignature
from passlib.context import CryptContext
from app.core.config import get_settings

settings = get_settings()

_pwd_context = CryptContext(schemes=['sha256_crypt'], deprecated='auto')
_signer = URLSafeSerializer(settings.SESSION_SECRET_KEY, salt='session')

def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)

def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_context.verify(plain, hashed)

def sign_session_id(session_id: uuid.UUID) -> str:
    """
    Подписывает session_id и возвращает строку для значения cookie.
    Формат: "<session_id>.<HMAC-SHA256 подпись>"
    """
    return _signer.dumps(str(session_id))

def unsign_session_id(cookie_value: str) -> uuid.UUID | None:
    """
    Верифицирует подпись cookie и возвращает session_id (UUID).
    Возвращает None если подпись невалидна или значение не является UUID.
    """
    try:
        raw = _signer.loads(cookie_value)
        return uuid.UUID(raw)
    except (BadSignature, ValueError):
        return None