import asyncio
import hashlib
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import get_settings
from app.core.logging import setup_logging, get_logger
from app.exceptions import (
    http_exception_handler,
    validation_exception_handler,
    generic_exception_handler,
)
from app.api_routes import columns, cards, users, events, notifications, board, admin, projects
from app.router import router as ws_router
from app.manager import manager
from app.tasks import event_cleanup_task, session_cleanup_task
from app.core.bootstrap import ensure_admin_exists

setup_logging()
logger = get_logger("main")
settings = get_settings()

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info('Starting TaskBoard MVP')

    await ensure_admin_exists()

    broadcast_task = asyncio.create_task(manager.broadcast_loop())
    cleanup_task = asyncio.create_task(event_cleanup_task())
    sess_cleanup_task  = asyncio.create_task(session_cleanup_task())

    yield

    logger.info('Shutting down TaskBoard MVP')
    broadcast_task.cancel()
    cleanup_task.cancel()
    sess_cleanup_task.cancel()
    try:
        await asyncio.gather(broadcast_task, cleanup_task, sess_cleanup_task, return_exceptions=True)
    except Exception:
        pass

app = FastAPI(
    title='taskBoard MVP',
    description='Async kanban — REST + WebSocket + cookie sessions',
    version='0.3.0',
    lifespan=lifespan,

    docs_url="/docs"      if settings.EXPOSE_DOCS else None,
    redoc_url="/redoc"    if settings.EXPOSE_DOCS else None,
    openapi_url="/openapi.json" if settings.EXPOSE_DOCS else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)

app.include_router(columns.router)
app.include_router(cards.router)
app.include_router(users.router)
app.include_router(events.router)
app.include_router(notifications.router)
app.include_router(board.router)
app.include_router(admin.router)
app.include_router(projects.router)
app.include_router(ws_router)

@app.get('/health', tags=['meta'])
async def health():
    return {'status': 'ok'}

current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(os.path.dirname(current_dir))
frontend_path = os.path.join(root_dir, "frontend")

print(f"DEBUG: Looking for frontend at: {frontend_path}")

SCRIPTS_JS_PATH = os.path.join(frontend_path, "static", "scripts.js")
INDEX_HTML_PATH = os.path.join(frontend_path, "index.html")

SCRIPT_TAG_PATTERN = 'src="./static/scripts.js?v='


def file_hash(path: str, length: int = 8) -> str:
    """Короткий md5-хэш содержимого файла — используется как cache-busting версия в URL."""
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()[:length]


class MyStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


app.mount("/static", MyStaticFiles(directory=os.path.join(frontend_path, "static"), html=True), name="static")

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads", "attachments")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

@app.get("/")
async def get_index():
    scripts_version = file_hash(SCRIPTS_JS_PATH)

    with open(INDEX_HTML_PATH, encoding="utf-8") as f:
        html = f.read()

    prefix, _, rest = html.partition(SCRIPT_TAG_PATTERN)
    if rest:
        _, _, tail = rest.partition('"')
        html = f'{prefix}{SCRIPT_TAG_PATTERN}{scripts_version}"{tail}'
    else:
        logger.warning("Не найден тег scripts.js в index.html — версия не подставлена")

    response = HTMLResponse(html)
    response.headers["Cache-Control"] = "no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return response