import uuid
import enum
from datetime import datetime, timezone
from sqlalchemy import String, ForeignKey, Integer, Boolean, DateTime, JSON, Text, CheckConstraint, Enum
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import UUID, ENUM as pgEnum
from app.db.session import Base

def utcnow() -> datetime:
    return datetime.now(timezone.utc)

class User(Base):
    __tablename__ = 'users'

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    online: Mapped[bool] = mapped_column(Boolean, default=False)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    

class Column(Base):
    __tablename__ = 'columns'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0)

    cards: Mapped[list['Card']] = relationship('Card', back_populates='column', lazy='select')

class CardPriority(str, enum.Enum):
    HIGHT = "HIGHT"
    MEDIUM = "MEDIUM"
    LOW = "LOW"

class Card(Base):
    __tablename__ = 'cards'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    column_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('columns.id', ondelete="RESTRICT"), nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id'), nullable=False)
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id', ondelete="SET NULL"), nullable=True)

    position: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    column: Mapped['Column'] = relationship('Column', back_populates='cards')
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default='false')

    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attachments: Mapped[list['Attachment']] = relationship('Attachment', back_populates='card', cascade='all, delete-orphan', lazy='selectin', passive_deletes=True)
    priority: Mapped[CardPriority] = mapped_column(postgresql.ENUM(CardPriority, name="cardpriority"), default=CardPriority.LOW, nullable=False, server_default='LOW')
    comments: Mapped[list['Comment']] = relationship('Comment', back_populates='card', cascade='all, delete-orphan', lazy='selectin', passive_deletes=True)
    events: Mapped[list['Event']] = relationship('Event', back_populates='card', cascade='all, delete-orphan')

    __table_args__ = (
        CheckConstraint('deadline >= created_at', name='check_deadline_future'),
    )

class Attachment(Base):
    __tablename__ = 'attachments'
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('cards.id', ondelete='CASCADE'), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(512), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    card: Mapped['Card'] = relationship('Card', back_populates='attachments')

class Comment(Base):
    __tablename__ = 'comments'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('cards.id', ondelete='CASCADE'), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='CASCADE'), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    card: Mapped['Card'] = relationship('Card', back_populates='comments')
    author: Mapped['User'] = relationship('User', lazy='selectin')

    def __repr__(self) -> str:
        return f'<Comment(id={self.id}, user_id={self.user_id}, card_id={self.card_id})>'
    
class EventType(str, enum.Enum):
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

class Event(Base):
    __tablename__ = 'events'
    id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='SET NULL'), nullable=False)
    card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('cards.id', ondelete='CASCADE'), nullable=True, index=True)
    event_type: Mapped[EventType] = mapped_column(pgEnum(EventType, name='eventtype'), nullable=False, index=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    card: Mapped['Card'] = relationship('Card', back_populates='events')
    user: Mapped['User'] = relationship('User')

class Session(Base):
    __tablename__ = 'sessions'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='CASCADE'), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    user: Mapped["User"] = relationship("User", lazy="select")

class Notification(Base):
    __tablename__ = 'notifications'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('cards.id', ondelete="CASCADE"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)