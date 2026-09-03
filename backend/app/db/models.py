import uuid
import enum
from datetime import datetime, timezone
from sqlalchemy import String, ForeignKey, Integer, Boolean, DateTime, JSON, Text, CheckConstraint, Table, and_, Column as SAColumn, Sequence
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import UUID, ENUM as pgEnum
from app.db.session import Base

def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Сквозные номера задач и категорий для быстрого поиска/менеджерирования.
# Отдельные последовательности на уровне БД: номер выдаётся атомарно на
# INSERT, без гонок, и не зависит от порядка/удаления других записей.
card_number_seq = Sequence('card_number_seq', start=1)
column_number_seq = Sequence('column_number_seq', start=1)


class UserRole(str, enum.Enum):
    """
    Роли системы.

    ADMIN      — заводит пользователей, назначает постановщиков, видит всё.
    TEAM_LEAD  — постановщик задач. Создаёт категории и задачи, назначает
                 исполнителей. Видит только СВОИ созданные задачи плюс те,
                 где он сам назначен исполнителем. Чужие задачи, включая
                 созданные админом, ему не видны.
    USER       — исполнитель. Видит только назначенные ему задачи, двигает их
                 между разрешёнными категориями, комментирует, шлёт файлы.
    """
    ADMIN = "ADMIN"
    TEAM_LEAD = "TEAM_LEAD"
    USER = "USER"


#======================================================
# Связь карточка <-> исполнители (many-to-many)
#======================================================
card_assignees = Table(
    'card_assignees',
    Base.metadata,
    SAColumn('card_id', UUID(as_uuid=True), ForeignKey('cards.id', ondelete='CASCADE'), primary_key=True),
    SAColumn('user_id', UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='CASCADE'), primary_key=True),
    SAColumn('assigned_at', DateTime(timezone=True), nullable=False, default=utcnow),
)


class User(Base):
    __tablename__ = 'users'

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    online: Mapped[bool] = mapped_column(Boolean, default=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    role: Mapped[UserRole] = mapped_column(
        pgEnum(UserRole, name='userrole'),
        nullable=False,
        default=UserRole.USER,
        server_default='USER',
        index=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default='true')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='SET NULL'), nullable=True
    )

    @property
    def is_manager(self) -> bool:
        """
        ADMIN или TEAM_LEAD — те, кто может создавать категории и задачи.
        Внимание: это НЕ право видеть или менять конкретную задачу —
        для этого есть CardService._can_view / _can_manage.
        """
        return self.role in (UserRole.ADMIN, UserRole.TEAM_LEAD)

    def __repr__(self) -> str:
        return f'<User(username={self.username}, role={self.role})>'


class Column(Base):
    """Категория доски. В будущем получит project_id."""
    __tablename__ = 'columns'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Сквозной порядковый номер колонки (не путать с position — той, что
    # задаёт порядок отображения). Выдаётся один раз при создании и
    # больше не меняется, поэтому годится как короткий стабильный
    # идентификатор для поиска и общения («колонка №7»).
    number: Mapped[int] = mapped_column(
        Integer, column_number_seq,
        server_default=column_number_seq.next_value(), unique=True, nullable=False, index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0)

    # Колонка принадлежит конкретному узлу дерева проектов.
    # У каждого проекта и подпроекта свой независимый набор колонок.
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False, index=True
    )

    # Разрешено ли обычному пользователю (role=USER) перетаскивать
    # свои карточки В эту колонку. Управляется админом/тим-лидером.
    # Открыто по умолчанию: ответственные работают со всеми категориями,
    # админ закрывает точечно. Существующие категории миграция не трогает.
    is_user_movable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default='true'
    )

    # Разрешено ли исполнителю заводить в этой категории собственные задачи.
    # Такие задачи видит только их автор, назначенные исполнители и админ —
    # постановщик проекта их не видит. Поэтому флаг ставит только админ.
    is_user_creatable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default='true'
    )

    cards: Mapped[list['Card']] = relationship('Card', back_populates='column', lazy='select')


class CardStatus(str, enum.Enum):
    """
    Стадия работы над задачей.

    Отличается от категории (колонки): колонки придумывает постановщик
    под свой процесс, а статус — общий для всей системы, поэтому по нему
    можно фильтровать и считать сводку одинаково во всех проектах.
    """
    NOT_STARTED = "NOT_STARTED"   # не начата
    IN_PROGRESS = "IN_PROGRESS"   # взята в работу
    PAUSED = "PAUSED"             # пауза: работа начата, но приостановлена
    REVIEW = "REVIEW"             # проверка
    REWORK = "REWORK"             # доработка
    DONE = "DONE"                 # готово


class CardPriority(str, enum.Enum):
    HIGHT = "HIGHT"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class Card(Base):
    __tablename__ = 'cards'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Сквозной порядковый номер задачи по всей системе — короткий,
    # стабильный, не меняется при переносе между колонками/проектами.
    # Именно по нему быстро ищут и называют задачу («задача №42»).
    number: Mapped[int] = mapped_column(
        Integer, card_number_seq,
        server_default=card_number_seq.next_value(), unique=True, nullable=False, index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    column_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('columns.id', ondelete="RESTRICT"), nullable=False)
    # Денормализация: всегда равен project_id своей колонки.
    # Держим полем, чтобы выборка по проекту и сводка корня
    # не требовали join и не разъезжались при переносе карточки.
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id'), nullable=False)

    position: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    column: Mapped['Column'] = relationship('Column', back_populates='cards')
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default='false')

    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attachments: Mapped[list['Attachment']] = relationship('Attachment', back_populates='card', cascade='all, delete-orphan', lazy='selectin', passive_deletes=True)
    priority: Mapped[CardPriority] = mapped_column(postgresql.ENUM(CardPriority, name="cardpriority"), default=CardPriority.LOW, nullable=False, server_default='LOW')
    status: Mapped[CardStatus] = mapped_column(
        pgEnum(CardStatus, name='cardstatus'),
        default=CardStatus.NOT_STARTED,
        nullable=False,
        server_default='NOT_STARTED',
        index=True,
    )
    comments: Mapped[list['Comment']] = relationship('Comment', back_populates='card', cascade='all, delete-orphan', lazy='selectin', passive_deletes=True)
    # Без delete-orphan: удаление карточки не должно стирать её историю.
    # За обнуление ссылки отвечает ON DELETE SET NULL на стороне БД,
    # поэтому ORM здесь не вмешивается (passive_deletes).
    events: Mapped[list['Event']] = relationship('Event', back_populates='card', passive_deletes=True)

    # Несколько исполнителей на одну задачу
    assignees: Mapped[list['User']] = relationship(
        'User',
        secondary=card_assignees,
        lazy='selectin',
        order_by='User.username',
    )

    creator: Mapped['User'] = relationship('User', foreign_keys=[created_by], lazy='selectin')

    # Ограничение «дедлайн не раньше создания» снято: задачу заводят
    # задним числом, а просроченный срок должен сохраняться при правке.
    # Просрочка — это состояние для показа, а не повод отклонить запись.

    def is_assignee(self, user_id: uuid.UUID) -> bool:
        return any(str(u.user_id) == str(user_id) for u in self.assignees)


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
    # Задачи
    CARD_CREATED = "CARD_CREATED"
    CARD_EDITED = "CARD_EDITED"
    CARD_MOVED = "CARD_MOVED"
    CARD_ASSIGNED = "CARD_ASSIGNED"
    CARD_STATUS_CHANGED = "CARD_STATUS_CHANGED"
    CARD_ARCHIVED = "CARD_ARCHIVED"
    CARD_RESTORED = "CARD_RESTORED"
    CARD_DELETED = "CARD_DELETED"
    # Комментарии и файлы
    COMMENT_ADDED = "COMMENT_ADDED"
    COMMENT_EDITED = "COMMENT_EDITED"
    COMMENT_DELETED = "COMMENT_DELETED"
    ATTACHMENT_ADDED = "ATTACHMENT_ADDED"
    ATTACHMENT_DELETED = "ATTACHMENT_DELETED"
    # Категории
    COLUMN_CREATED = "COLUMN_CREATED"
    COLUMN_UPDATED = "COLUMN_UPDATED"
    COLUMN_DELETED = "COLUMN_DELETED"
    # Проекты и подпроекты
    PROJECT_CREATED = "PROJECT_CREATED"
    PROJECT_UPDATED = "PROJECT_UPDATED"
    PROJECT_DELETED = "PROJECT_DELETED"
    # Учётные записи
    USER_CREATED = "USER_CREATED"
    USER_UPDATED = "USER_UPDATED"
    USER_DEACTIVATED = "USER_DEACTIVATED"
    USER_LOGIN = "USER_LOGIN"
    USER_LOGOUT = "USER_LOGOUT"

    @property
    def category(self) -> str:
        name = self.value
        if name.startswith('CARD_'):
            return 'card'
        if name.startswith('COMMENT_') or name.startswith('ATTACHMENT_'):
            return 'card'
        if name.startswith('COLUMN_'):
            return 'column'
        if name.startswith('PROJECT_'):
            return 'project'
        return 'user' 


class Event(Base):
    """
    Запись журнала действий.

    Все человекочитаемые названия сохраняются прямо в строке события,
    а не берутся из связей: журнал должен переживать удаление карточки,
    колонки, проекта или пользователя и по-прежнему показывать, что
    именно произошло. Ссылки на сущности остаются для перехода,
    но обнуляются при удалении (SET NULL), а не уносят историю за собой.
    """
    __tablename__ = 'events'
    id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Кто выполнил действие
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='SET NULL'), nullable=True, index=True)
    actor_username: Mapped[str | None] = mapped_column(String(100), nullable=True)
    actor_role: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Над чем выполнено
    card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('cards.id', ondelete='SET NULL'), nullable=True, index=True)
    card_title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey('projects.id', ondelete='SET NULL'), nullable=True, index=True)
    project_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    column_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Кого касается действие (для событий с учётными записями и исполнителями)
    target_username: Mapped[str | None] = mapped_column(String(100), nullable=True)

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


#======================================================
# Проекты
#======================================================
class ProjectRole(str, enum.Enum):
    """Роль пользователя внутри конкретного проекта."""
    OWNER = "OWNER"      # постановщик, отвечающий за проект
    MEMBER = "MEMBER"    # ответственный исполнитель, работающий в проекте


project_members = Table(
    'project_members',
    Base.metadata,
    SAColumn('project_id', UUID(as_uuid=True), ForeignKey('projects.id', ondelete='CASCADE'), primary_key=True),
    SAColumn('user_id', UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='CASCADE'), primary_key=True),
    SAColumn('role_in_project', pgEnum(ProjectRole, name='projectrole'), nullable=False, server_default='OWNER'),
    SAColumn('added_at', DateTime(timezone=True), nullable=False, default=utcnow),
)


class Project(Base):
    """
    Проект или подпроект. Вложенность ровно одна:
    у корневого проекта parent_id = NULL, у подпроекта указывает на корневой.
    Подпроект подпроекта запрещён на уровне сервиса.

    У каждого узла своя независимая доска: свои колонки и свои карточки.
    Корневой проект дополнительно показывает сводку по подпроектам.
    """
    __tablename__ = 'projects'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey('projects.id', ondelete='CASCADE'), nullable=True, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default='false')

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey('users.user_id', ondelete='SET NULL'), nullable=True
    )

    children: Mapped[list['Project']] = relationship(
        'Project',
        back_populates='parent',
        cascade='all, delete-orphan',
        lazy='selectin',
        order_by='Project.position',
    )
    parent: Mapped['Project | None'] = relationship('Project', back_populates='children', remote_side=[id])

    # Обе связи только для чтения: состав правится core-запросами
    # в репозитории, потому что у таблицы связи есть своя колонка роли.
    owners: Mapped[list['User']] = relationship(
        'User',
        secondary=project_members,
        primaryjoin=lambda: and_(
            Project.id == project_members.c.project_id,
            project_members.c.role_in_project == ProjectRole.OWNER,
        ),
        secondaryjoin=lambda: User.user_id == project_members.c.user_id,
        viewonly=True, lazy='selectin', order_by='User.username',
    )

    # Ответственные исполнители: попадают в исполнители новых задач,
    # видят проект целиком и заводят в нём собственные задачи.
    members: Mapped[list['User']] = relationship(
        'User',
        secondary=project_members,
        primaryjoin=lambda: and_(
            Project.id == project_members.c.project_id,
            project_members.c.role_in_project == ProjectRole.MEMBER,
        ),
        secondaryjoin=lambda: User.user_id == project_members.c.user_id,
        viewonly=True, lazy='selectin', order_by='User.username',
    )

    @property
    def is_root(self) -> bool:
        return self.parent_id is None

    def __repr__(self) -> str:
        return f'<Project(name={self.name}, root={self.is_root})>'