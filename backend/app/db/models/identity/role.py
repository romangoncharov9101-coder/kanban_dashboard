import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.db.models.mixins import utcnow

class RoleName:
    ADMIN = 'АДМИН'
    MANAGER = 'МЕНЕДЖЕР'
    USER = 'ПОЛЬЗОВАТЕЛЬ'

class Role(Base):
    __tablename__ = 'roles'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, server_default='false')
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='SET NULL'), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    users: Mapped[list['User']] = relationship('User', back_populates='role')
    permissions: Mapped[list['Permission']] = relationship('Permission', back_populates='role', cascade='all, delete-orphin', lazy='selection')
    