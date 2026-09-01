import uuid
from datetime import datetime, timezone

from sqlalchemy import delete, func, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import Card, Column, Project, ProjectRole, User, UserRole, card_assignees, project_members


class ProjectRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    def _base(self):
        return select(Project).options(
            selectinload(Project.owners),
            selectinload(Project.members),
            selectinload(Project.children).selectinload(Project.owners),
            selectinload(Project.children).selectinload(Project.members),
        )

    async def get_by_id(self, project_id: uuid.UUID) -> Project | None:
        result = await self.session.execute(self._base().where(Project.id == project_id))
        return result.scalar_one_or_none()

    async def get_roots(self) -> list[Project]:
        result = await self.session.execute(
            self._base().where(Project.parent_id.is_(None)).order_by(Project.position, Project.name)
        )
        return list(result.scalars().unique().all())

    async def get_all(self) -> list[Project]:
        result = await self.session.execute(self._base().order_by(Project.position, Project.name))
        return list(result.scalars().unique().all())

    async def get_children_ids(self, project_id: uuid.UUID) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(Project.id).where(Project.parent_id == project_id)
        )
        return list(result.scalars().all())

    async def get_max_position(self, parent_id: uuid.UUID | None) -> int:
        q = select(func.max(Project.position))
        q = q.where(Project.parent_id.is_(None)) if parent_id is None else q.where(Project.parent_id == parent_id)
        result = await self.session.execute(q)
        val = result.scalar_one_or_none()
        return val if val is not None else -1

    async def create(
        self,
        name: str,
        parent_id: uuid.UUID | None,
        position: int,
        description: str | None = None,
        created_by: uuid.UUID | None = None,
    ) -> Project:
        project = Project(
            id=uuid.uuid4(),
            name=name,
            description=description,
            parent_id=parent_id,
            position=position,
            created_by=created_by,
        )
        self.session.add(project)
        await self.session.flush()
        return await self.get_by_id(project.id)

    async def update(self, project: Project, **kwargs) -> Project:
        for k, v in kwargs.items():
            setattr(project, k, v)
        await self.session.flush()
        return await self.get_by_id(project.id)

    async def delete(self, project: Project) -> None:
        await self.session.delete(project)
        await self.session.flush()

    #======================================================
    # Владельцы (постановщики, отвечающие за проект)
    #======================================================
    async def get_participant_ids(
        self, project_id: uuid.UUID, role: ProjectRole
    ) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(project_members.c.user_id).where(
                project_members.c.project_id == project_id,
                project_members.c.role_in_project == role,
            )
        )
        return list(result.scalars().all())

    async def get_owner_ids(self, project_id: uuid.UUID) -> list[uuid.UUID]:
        return await self.get_participant_ids(project_id, ProjectRole.OWNER)

    async def get_member_ids(self, project_id: uuid.UUID) -> list[uuid.UUID]:
        return await self.get_participant_ids(project_id, ProjectRole.MEMBER)

    async def set_participants(
        self, project: Project, user_ids: list[uuid.UUID], role: ProjectRole
    ) -> None:
        """
        Заменяет состав участников с указанной ролью.
        Роли живут в одной таблице, поэтому все запросы обязаны
        фильтровать по role_in_project — иначе постановщики и
        ответственные затрут друг друга.
        """
        current = set(await self.get_participant_ids(project.id, role))
        target = set(user_ids)

        to_remove = current - target
        to_add = target - current

        if to_remove:
            await self.session.execute(
                delete(project_members).where(
                    project_members.c.project_id == project.id,
                    project_members.c.role_in_project == role,
                    project_members.c.user_id.in_(to_remove),
                )
            )
        if to_add:
            await self.session.execute(
                insert(project_members),
                [
                    {
                        'project_id': project.id,
                        'user_id': uid,
                        'role_in_project': role,
                        'added_at': datetime.now(timezone.utc),
                    }
                    for uid in to_add
                ],
            )
        await self.session.flush()
        if to_remove or to_add:
            # Связь меняется core-запросами, ORM об этом не знает.
            self.session.expire(project, ['owners', 'members'])

    async def set_owners(self, project: Project, user_ids: list[uuid.UUID]) -> None:
        await self.set_participants(project, user_ids, ProjectRole.OWNER)

    async def set_members(self, project: Project, user_ids: list[uuid.UUID]) -> None:
        await self.set_participants(project, user_ids, ProjectRole.MEMBER)

    async def get_project_ids_by_role(
        self, user_id: uuid.UUID, role: ProjectRole
    ) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(project_members.c.project_id).where(
                project_members.c.user_id == user_id,
                project_members.c.role_in_project == role,
            )
        )
        return list(result.scalars().all())

    async def get_owned_project_ids(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Проекты, за которые пользователь отвечает как постановщик."""
        return await self.get_project_ids_by_role(user_id, ProjectRole.OWNER)

    async def get_member_project_ids(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Проекты, где пользователь — ответственный исполнитель."""
        return await self.get_project_ids_by_role(user_id, ProjectRole.MEMBER)

    async def get_project_ids_with_assignments(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Проекты, где у пользователя есть хотя бы одна назначенная задача."""
        result = await self.session.execute(
            select(Card.project_id)
            .join(card_assignees, card_assignees.c.card_id == Card.id)
            .where(card_assignees.c.user_id == user_id)
            .distinct()
        )
        return list(result.scalars().all())

    async def get_project_ids_with_authored_cards(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Проекты, где пользователь создавал задачи."""
        result = await self.session.execute(
            select(Card.project_id).where(Card.created_by == user_id).distinct()
        )
        return list(result.scalars().all())

    async def get_project_ids_with_own_creatable_assignment(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """
        Проекты, где у пользователя уже есть назначенная задача в личной
        категории (is_user_creatable). Пока такой задачи нет, ни колонка,
        ни сам проект (если он не виден по другой причине) исполнителю
        не показываются — первую задачу туда должен положить постановщик
        или админ.
        """
        result = await self.session.execute(
            select(Card.project_id)
            .join(card_assignees, card_assignees.c.card_id == Card.id)
            .join(Column, Column.id == Card.column_id)
            .where(card_assignees.c.user_id == user_id, Column.is_user_creatable.is_(True))
            .distinct()
        )
        return list(result.scalars().all())

    async def count_cards(self, project_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
        """Все незаархивированные задачи проекта, без учёта прав."""
        if not project_ids:
            return {}
        result = await self.session.execute(
            select(Card.project_id, func.count(Card.id))
            .where(Card.project_id.in_(project_ids), Card.is_archived.is_(False))
            .group_by(Card.project_id)
        )
        return {row[0]: row[1] for row in result.all()}

    async def count_cards_for_viewer(
        self, project_ids: list[uuid.UUID], viewer: User
    ) -> dict[uuid.UUID, int]:
        """
        Счётчик задач под конкретного зрителя — то же правило видимости,
        что и в выдаче карточек. Иначе в меню проектов светилось бы число
        больше, чем человек реально видит на доске.
        """
        if not project_ids:
            return {}

        q = (
            select(Card.project_id, func.count(Card.id))
            .where(Card.project_id.in_(project_ids), Card.is_archived.is_(False))
        )

        if viewer.role is not UserRole.ADMIN:
            assigned = select(card_assignees.c.card_id).where(
                card_assignees.c.user_id == viewer.user_id
            )
            cond = Card.id.in_(assigned)
            if viewer.role is UserRole.TEAM_LEAD:
                cond = or_(cond, Card.created_by == viewer.user_id)
            q = q.where(cond)

        result = await self.session.execute(q.group_by(Card.project_id))
        return {row[0]: row[1] for row in result.all()}