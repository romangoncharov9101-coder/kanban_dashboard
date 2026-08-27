from pydantic import BaseModel, Field, field_validator
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID
import re


class UserRole(str, Enum):
    ADMIN = "ADMIN"
    TEAM_LEAD = "TEAM_LEAD"
    USER = "USER"


class UserShortOut(BaseModel):
    user_id: UUID
    username: str

    model_config = {'from_attributes': True}

#======================================================
# Attachments
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
    assignee_ids: list[UUID] = Field(default_factory=list, max_length=20)
    deadline: datetime | None = None
    priority: CardPriority = CardPriority.LOW

    @field_validator('title')
    @classmethod
    def validate_title(cls, v: str):
        if not v.strip():
            raise ValueError('Название карточки не может быть пустым')
        return v

    @field_validator('assignee_ids')
    @classmethod
    def dedupe_assignees(cls, v: list[UUID]):
        seen, out = set(), []
        for uid in v:
            if uid not in seen:
                seen.add(uid)
                out.append(uid)
        return out

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
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    column_id: UUID | None = None
    assignee_ids: list[UUID] | None = Field(None, max_length=20)
    deadline: datetime | None = None
    priority: CardPriority | None = None
    is_archived: bool | None = None

    @field_validator('assignee_ids')
    @classmethod
    def dedupe_assignees(cls, v: list[UUID] | None):
        if v is None:
            return v
        seen, out = set(), []
        for uid in v:
            if uid not in seen:
                seen.add(uid)
                out.append(uid)
        return out

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
    project_id: UUID
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
    assignees: list[UserShortOut] = []

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
# Projects
#======================================================
class ProjectRole(str, Enum):
    OWNER = "OWNER"


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    description: str | None = Field(None, max_length=2000)
    # None -> корневой проект; иначе подпроект указанного корня
    parent_id: UUID | None = None
    owner_ids: list[UUID] = Field(default_factory=list, max_length=20)

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str):
        if not v.strip():
            raise ValueError('Название проекта не может быть пустым')
        return v.strip()


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=150)
    description: str | None = Field(None, max_length=2000)
    position: int | None = Field(None, ge=0)
    is_archived: bool | None = None
    owner_ids: list[UUID] | None = Field(None, max_length=20)


class ProjectOut(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    parent_id: UUID | None = None
    position: int
    is_archived: bool
    owners: list[UserShortOut] = []
    children: list['ProjectOut'] = []
    # Заполняется сервисом под конкретного зрителя
    can_manage: bool = False
    open_tasks: int = 0

    model_config = {'from_attributes': True}


ProjectOut.model_rebuild()


#======================================================
# Columns
#======================================================
class ColumnCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    project_id: UUID
    is_user_movable: bool = False

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str):
        if not v.strip():
            raise ValueError('Название колонки не может быть пустым')
        return v


class ColumnUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    position: int | None = Field(None, ge=0)
    is_user_movable: bool | None = None


class ColumnOut(BaseModel):
    id: UUID
    name: str
    position: int
    project_id: UUID
    is_user_movable: bool

    model_config = {'from_attributes': True}

#======================================================
# Users / Auth
#======================================================
_USERNAME_RE = r'^[a-zA-Zа-яА-ЯёЁґҐєЄіІїЇ0-9_.-]+$'


class UserLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=6, max_length=128)


class UserOut(BaseModel):
    user_id: UUID
    username: str
    online: bool
    role: UserRole
    is_active: bool

    model_config = {'from_attributes': True}


class UserLoginResponse(BaseModel):
    user_id: UUID
    username: str
    role: UserRole


class AdminUserCreate(BaseModel):
    """Создание пользователя администратором. Самостоятельной регистрации нет."""
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=6, max_length=128)
    role: UserRole = UserRole.USER

    @field_validator('username')
    @classmethod
    def validate_username(cls, v: str):
        v = v.strip()
        if not re.match(_USERNAME_RE, v):
            raise ValueError('Логин: буквы, цифры, _ . - без пробелов')
        return v


class AdminUserUpdate(BaseModel):
    """Частичное обновление. Все поля опциональны."""
    password: str | None = Field(None, min_length=6, max_length=128)
    role: UserRole | None = None
    is_active: bool | None = None


class AdminUserOut(UserOut):
    created_at: datetime
    created_by: UUID | None = None

    model_config = {'from_attributes': True}

#======================================================
# WebSocket
#======================================================
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
