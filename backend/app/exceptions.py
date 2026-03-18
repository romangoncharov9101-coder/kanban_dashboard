from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from typing import Any
from app.core.logging import get_logger

def error_response(code: str, message: str, details: Any = None, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={'error': {'code': code, 'message': message, 'details': details}}
    )

async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code_map = {
        400: 'BAD_REQUEST',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        422: 'UNPROCESSABLE_ENTUTY',
        500: 'INTERNAL_SERVER_ERROR'
    }
    code = code_map.get(exc.status_code, 'HTTP_ERROR')
    return error_response(code, str(exc.detail), status_code=exc.status_code)

async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return error_response(
        'VALIDATION_ERROR',
        'Request validation failed',
        details=exc.errors(),
        status_code=422
    )

async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger = get_logger('exception_handler')
    logger.error(f'Unhandled exception: {exc}', exc_info=True)
    return error_response('INTERNAL_SERVER_ERRO', 'Internal server error', status_code=500)