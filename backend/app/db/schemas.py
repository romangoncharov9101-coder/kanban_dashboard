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


# Управляющие и невидимые символы в названиях недопустимы — они ломают
# вёрстку и логи. Всё остальное печатное разрешено: скобки, кавычки,
# тире, запятые и прочая пунктуация в названиях нужны постоянно.
_CTRL_CHARS = re.compile(r'[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\ufeff]')


def clean_name(value: str, what: str) -> str:
    v = (value or '').strip()
    if not v:
        raise ValueError(f'{what} не может быть пустым')
    if _CTRL_CHARS.search(v):
        raise ValueError(f'{what} содержит недопустимые символы')
    return v


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
    CARD_ASSIGNED = "CARD_ASSIGNED"
    CARD_STATUS_CHANGED = "CARD_STATUS_CHANGED"
    CARD_ARCHIVED = "CARD_ARCHIVED"
    CARD_RESTORED = "CARD_RESTORED"
    CARD_DELETED = "CARD_DELETED"
    COMMENT_ADDED = "COMMENT_ADDED"
    COMMENT_EDITED = "COMMENT_EDITED"
    COMMENT_DELETED = "COMMENT_DELETED"
    ATTACHMENT_ADDED = "ATTACHMENT_ADDED"
    ATTACHMENT_DELETED = "ATTACHMENT_DELETED"
    COLUMN_CREATED = "COLUMN_CREATED"
    COLUMN_UPDATED = "COLUMN_UPDATED"
    COLUMN_DELETED = "COLUMN_DELETED"
    PROJECT_CREATED = "PROJECT_CREATED"
    PROJECT_UPDATED = "PROJECT_UPDATED"
    PROJECT_DELETED = "PROJECT_DELETED"
    USER_CREATED = "USER_CREATED"
    USER_UPDATED = "USER_UPDATED"
    USER_DEACTIVATED = "USER_DEACTIVATED"
    USER_LOGIN = "USER_LOGIN"
    USER_LOGOUT = "USER_LOGOUT"


class EventOut(BaseModel):
    id: UUID
    card_id: UUID | None = None
    user_id: UUID | None = None
    user: UserShortOut | None = None
    event_type: EventType
    message: str
    payload: dict[str, Any] = {}
    created_at: datetime

    # Названия сохранены в самом событии, чтобы журнал оставался
    # читаемым после удаления карточки, проекта или пользователя
    actor_username: str | None = None
    actor_role: str | None = None
    card_title: str | None = None
    project_id: UUID | None = None
    project_name: str | None = None
    column_name: str | None = None
    target_username: str | None = None

    model_config = {'from_attributes': True}


class EventPage(BaseModel):
    """Страница журнала действий."""
    items: list[EventOut]
    total: int
    limit: int
    offset: int

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


class CardStatus(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    IN_PROGRESS = "IN_PROGRESS"
    REVIEW = "REVIEW"
    REWORK = "REWORK"
    DONE = "DONE"


class CardCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    column_id: UUID
    assignee_ids: list[UUID] = Field(default_factory=list, max_length=20)
    deadline: datetime | None = None
    priority: CardPriority = CardPriority.LOW
    status: CardStatus = CardStatus.NOT_STARTED

    @field_validator('title')
    @classmethod
    def validate_title(cls, v: str):
        return clean_name(v, 'Название задачи')

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

    @field_validator('title')
    @classmethod
    def validate_title(cls, v: str | None):
        return v if v is None else clean_name(v, 'Название задачи')

    description: str | None = None
    column_id: UUID | None = None
    assignee_ids: list[UUID] | None = Field(None, max_length=20)
    deadline: datetime | None = None
    priority: CardPriority | None = None
    status: CardStatus | None = None
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


class CardStatusUpdate(BaseModel):
    """Смена стадии работы. Доступна и исполнителю задачи."""
    status: CardStatus


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
    status: CardStatus = CardStatus.NOT_STARTED
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
    MEMBER = "MEMBER"


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    description: str | None = Field(None, max_length=2000)
    # None -> корневой проект; иначе подпроект указанного корня
    parent_id: UUID | None = None
    owner_ids: list[UUID] = Field(default_factory=list, max_length=20)
    # Ответственные исполнители проекта
    member_ids: list[UUID] = Field(default_factory=list, max_length=50)

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str):
        return clean_name(v, 'Название проекта')


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=150)

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str | None):
        return v if v is None else clean_name(v, 'Название проекта')

    description: str | None = Field(None, max_length=2000)
    position: int | None = Field(None, ge=0)
    is_archived: bool | None = None
    owner_ids: list[UUID] | None = Field(None, max_length=20)
    member_ids: list[UUID] | None = Field(None, max_length=50)


class ProjectOut(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    parent_id: UUID | None = None
    position: int
    is_archived: bool
    owners: list[UserShortOut] = []
    members: list[UserShortOut] = []
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
    # Открыто по умолчанию: ответственные работают со всеми категориями,
    # админ ограничивает точечно
    is_user_movable: bool = True
    is_user_creatable: bool = True

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str):
        return clean_name(v, 'Название категории')


class ColumnUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str | None):
        return v if v is None else clean_name(v, 'Название категории')

    position: int | None = Field(None, ge=0)
    is_user_movable: bool | None = None
    is_user_creatable: bool | None = None


class ColumnOut(BaseModel):
    id: UUID
    name: str
    position: int
    project_id: UUID
    is_user_movable: bool
    is_user_creatable: bool = False

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
