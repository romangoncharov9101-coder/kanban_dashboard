import hashlib
import os

_here = os.path.dirname(os.path.abspath(__file__))          # backend/app/core
_backend_dir = os.path.dirname(os.path.dirname(_here))      # backend
_root_dir = os.path.dirname(_backend_dir)                   # project root

FRONTEND_PATH = os.path.join(_root_dir, "frontend")
SCRIPTS_JS_PATH = os.path.join(FRONTEND_PATH, "static", "scripts.js")
INDEX_HTML_PATH = os.path.join(FRONTEND_PATH, "index.html")


def get_app_version(length: int = 8) -> str:
    """
    Короткий md5-хэш содержимого scripts.js — единая версия приложения.

    Используется в двух местах:
    - как cache-busting query-параметр в теге <script> (main.py, /),
      чтобы браузер скачал новый файл вместо кэшированного;
    - как значение, с которым сверяется версия, загруженная клиентом,
      при подключении по WebSocket (router.py) — если они разошлись,
      значит на сервере уже лежит новый код, и клиенту стоит показать
      предложение обновить страницу (см. 'app_updated' в scripts.js).

    Файл маленький, поэтому читаем и хэшируем каждый раз заново —
    так значение всегда соответствует тому, что реально лежит на диске,
    без риска раздать протухший кэш в памяти процесса.
    """
    with open(SCRIPTS_JS_PATH, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()[:length]