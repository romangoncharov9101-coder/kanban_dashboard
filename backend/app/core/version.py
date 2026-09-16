import hashlib
import os

_here = os.path.dirname(os.path.abspath(__file__))          # backend/app/core
_backend_dir = os.path.dirname(os.path.dirname(_here))      # backend
_root_dir = os.path.dirname(_backend_dir)                   # project root

FRONTEND_PATH = os.path.join(_root_dir, "frontend")
SCRIPTS_JS_PATH = os.path.join(FRONTEND_PATH, "static", "scripts.js")
INDEX_HTML_PATH = os.path.join(FRONTEND_PATH, "index.html")


def _compute_version(length: int = 8) -> str:
    with open(SCRIPTS_JS_PATH, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()[:length]


# Версия вычисляется ОДИН РАЗ при импорте модуля (т.е. при старте процесса)
# и дальше не меняется, пока процесс жив.
APP_VERSION = _compute_version()


def get_app_version() -> str:
    return APP_VERSION