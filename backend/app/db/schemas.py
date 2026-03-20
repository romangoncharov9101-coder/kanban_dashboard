from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Optional, Any
from datetime import datetime
from uuid import UUID
import re

#======================================================
# Events
#======================================================
class EventOut(BaseModel):
    id: UUID
    event: str
    entity_id: str | None
    payload: dict[str, Any]
    created_at: datetime

    model_config = {'from_attributes': True}

#======================================================
# Cards
#======================================================
class CardCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    column_id: UUID
    assigned_to: UUID | None = None
    created_by: UUID

    @field_validator('title')
    @classmethod
    def validate_username(cls, v: str):
        if not re.match(r'^[a-zA-Zа-яА-ЯёЁ0-9\s]+$', v):
            raise ValueError('Название карточки может содержать только латинские или кирилические буквы без пробелов и знаков')
        return v

class CardUpdate(BaseModel):
    title: str | None = Field(..., min_length=1, max_length=200)
    description: str | None = None
    column_id: UUID | None = None
    assigned_to: UUID | None = None

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
    created_at: datetime
    updated_at: datetime | None

    created_by_username: str | None = None
    assigned_to_username: str | None = None

    model_config = {'from_attributes': True}

#======================================================
# Columns
#======================================================
class ColumnCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)

    @field_validator('name')
    @classmethod
    def validate_username(cls, v: str):
        if not re.match(r'^[a-zA-Zа-яА-ЯёЁ0-9\s]+$', v):
            raise ValueError('Название колонки может содержать только латинские или кирилические буквы без пробелов и знаков')
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
        if not re.match(r'^[a-zA-Zа-яА-ЯёЁ0-9\s]+$', v):
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