from pydantic import BaseModel, Field, field_validator
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID
import re

class UserShortOut(BaseModel):
    user_id: UUID
    username: str

    model_config = {'from_attributes': True}

#======================================================
# Attachments (Новое)
#======================================================
class AttachmentOut(BaseModel):
    id: UUID
    filename: str
    stored_filename: str
    content_type: str | None = None
    created_at: datetime

    model_config = {'from_attributes': True}

#======================================================
# Events
#======================================================
class EventType(str, Enum):
    CARD_CREATED = "CARD_CREATED"
    CARD_EDITED = "CARD_EDITED"
    CARD_MOVED = "CARD_MOVED"
    CARD_ARCHIVED = "CARD_ARCHIVED"
    CARD_RESTORED = "CARD_RESTORED"
    CARD_DELETED = "CARD_DELETED"
    COMMENT_ADDED = "COMMENT_ADDED"
    COMMENT_EDITED = "COMMENT_EDITED"
    COMMENT_DELETED = "COMMENT_DELETED"
    ATTACHMENT_ADDED = "ATTACHMENT_ADDED"
    ATTACHMENT_DELETED = "ATTACHMENT_DELETED"
    COLUMN_CREATED = "COLUMN_CREATED"
    COLUMN_DELETED = "COLUMN_DELETED"
    

class EventOut(BaseModel):
    id: UUID
    card_id: UUID | None
    user_id: UUID | None
    user: UserShortOut | None
    event_type: EventType
    message: str
    payload: dict[str, Any]
    created_at: datetime

    model_config = {'from_attributes': True}

# class EventOut(BaseModel):
#     id: UUID
#     event: str
#     entity_id: str | None
#     payload: dict[str, Any]
#     created_at: datetime

#     model_config = {'from_attributes': True}

#======================================================
# Comments
#======================================================
class CommentCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)

class CommentUpdate(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)

class CommentOut(BaseModel):
    id: UUID
    text: str
    card_id: UUID
    user_id: UUID
    author: UserShortOut
    created_at: datetime
    updated_at: datetime

    model_config = {'from_attributes': True}

#======================================================
# Cards
#======================================================
class CardPriority(str, Enum):
    HIGHT = "HIGHT"
    MEDIUM = "MEDIUM"
    LOW = "LOW"

class CardCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    column_id: UUID
    assigned_to: UUID | None = None
    created_by: UUID
    deadline: datetime | None = None
    priority: CardPriority = CardPriority.LOW

    @field_validator('title')
    @classmethod
    def validate_title(cls, v: str):
        if not v.strip():
            raise ValueError('Название карточки не может быть пустым')
        return v
    
    @field_validator('deadline')
    @classmethod
    def validate_deadline(cls, v: datetime | None):
        if v is None:
            return v
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        
        if v < datetime.now(timezone.utc):
            raise ValueError('Дедлайн не может быть в прошлом')
        return v

class CardUpdate(BaseModel):
    title: str | None = Field(..., min_length=1, max_length=200)
    description: str | None = None
    column_id: UUID | None = None
    assigned_to: UUID | None = None
    deadline: datetime | None = None
    priority: CardPriority | None = None
    is_archived: bool | None = None

    @field_validator('deadline')
    @classmethod
    def validate_deadline(cls, v: datetime | None):
        if v is None: return v
        if v.tzinfo is None: v = v.replace(tzinfo=timezone.utc)
        if v < datetime.now(timezone.utc):
            raise ValueError('Дедлайн не может быть в прошлом')
        return v

class CardMoveRequest(BaseModel):
    target_column_id: UUID
    target_position: int = Field(..., ge=0)

class CardOut(BaseModel):
    id: UUID
    title: str
    description: str | None
    column_id: UUID
    assigned_to: UUID | None
    created_by: UUID
    position: int
    priority: CardPriority
    is_archived: bool

    created_at: datetime
    updated_at: datetime | None
    deadline: datetime | None = None
    attachments: list[AttachmentOut] = []
    comments_count: int = 0
    created_by_username: str | None = None
    assigned_to_username: str | None = None

    @field_validator('attachments')
    @classmethod
    def check_attachments_limit(cls, v: list[AttachmentOut]):
        if len(v) > 5:
            return v[:5]
        return v

    model_config = {'from_attributes': True}

class DetailedOut(CardOut):
    comments: list[CommentOut] = []

class CardHistoryOut(BaseModel):
    card_id: UUID
    title: str
    logs: list[EventOut]

#======================================================
# Columns
#======================================================
class ColumnCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str):
        if not v.strip():
            raise ValueError('Название колонки не может быть пустым')
        return v

class ColumnUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    position: int | None = Field(None, ge=0)

class ColumnOut(BaseModel):
    id: UUID
    name: str
    position: int

    model_config = {'from_attributes': True}

#======================================================
# Users
#======================================================
class UserLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=6, max_length=128)

class UserRegisterRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=6, max_length=128)

    @field_validator('username')
    @classmethod
    def validate_username(cls, v: str):
        if not re.match(r'^[a-zA-Zа-яА-ЯёЁґҐєЄіІїЇ0-9\s]+$', v):
            raise ValueError('Никнейм может содержать только латинские или кирилические буквы без пробелов и знаков')
        return v

class UserOut(BaseModel):
    user_id: UUID
    username: str
    online: bool

    model_config = {'from_attributes': True}

class UserLoginResponse(BaseModel):
    user_id: UUID
    username: str

class cardDragEvent(BaseModel):
    card_id: UUID
    dragged_by: UUID
    username: str
    source_column_id: UUID
    current_column_id: UUID
    current_position: int

class WSMessage(BaseModel):
    event: str
    entity_id: str | None = None
    payload: dict[str, Any] = {}
    timestamp: str