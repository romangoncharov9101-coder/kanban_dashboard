from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, Any
from datetime import datetime
from uuid import UUID

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
    updated_at: datetime

    model_config = {'from_attributes': True}

#======================================================
# Columns
#======================================================
class ColumnCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)

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

class UserOut(BaseModel):
    user_id: UUID
    username: str
    online: bool

    model_config = {'from_attributes': True}

class UserLoginResponse(BaseModel):
    user_id: UUID
    username: str
    token: str

class WSMessage(BaseModel):
    event: str
    entity_id: str | None = None
    payload: dict[str, Any] = {}
    timestamp: str