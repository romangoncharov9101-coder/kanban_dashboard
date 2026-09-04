import os
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.models import Attachment, Card, CardStatus, User, UserRole
from app.db.schemas import (
    CardCreate, CardMoveRequest, CardOut, CardStatusUpdate, CardUpdate,
    CommentOut, EventType,
)
from app.manager import manager
from app.repositories.card_repo import CardRepository
from app.repositories.column_repo import ColumnRepository
from app.repositories.event_repo import EventRepository
from app.repositories.notif_repo import NotificationRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.user_repo import UserRepository

logger = get_logger('services.card')
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(_BASE_DIR, "uploads", "attachments")
os.makedirs(UPLOAD_DIR, exist_ok=True)


class CardService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = CardRepository(session)
        self.column_repo = ColumnRepository(session)
        self.event_repo = EventRepository(session)
        self.user_repo = UserRepository(session)
        self.notif_repo = NotificationRepository(session)
        self.project_repo = ProjectRepository(session)

    #======================================================
    # Права доступа
    #======================================================
    @staticmethod
    def _audience(card: Card) -> set[str]:
        """
        Кому адресованы WS-события по карточке: исполнители и автор.
        Админы получают всё (include_privileged в manager.publish).
        Постановщик, не связанный с карточкой, событий по ней не получает.
        """
        aud = {str(u.user_id) for u in card.assignees}
        aud.add(str(card.created_by))
        return aud

    @staticmethod
    def _can_view(card: Card, user: User) -> bool:
        """
        ADMIN — видит всё.
        Остальные — задачи, где они исполнители, плюс созданные ими самими.

        Личная задача исполнителя (заведённая им в разрешённой категории)
        подпадает под это правило автоматически: постановщик проекта не
        является ни её автором, ни исполнителем, поэтому не видит её —
        ровно как и задумано. Видят автор, назначенные и админ.
        """
        if user.role is UserRole.ADMIN:
            return True
        if card.is_assignee(user.user_id):
            return True
        return str(card.created_by) == str(user.user_id)

    @staticmethod
    def _can_manage(card: Card, user: User) -> bool:
        """
        Право менять саму задачу: заголовок, описание, дедлайн,
        приоритет, состав исполнителей, архивацию и удаление.
        Принадлежит админу и автору задачи. Быть исполнителем — мало.

        Исполнитель, заведший личную задачу, ею и распоряжается:
        может дописать условие и добавить к себе коллег.
        """
        if user.role is UserRole.ADMIN:
            return True
        return str(card.created_by) == str(user.user_id)

    @staticmethod
    def _can_change_status(card: Card, user: User) -> bool:
        """
        Стадию работы двигает тот, кто над задачей работает:
        админ, автор задачи и любой её исполнитель.
        Это шире, чем право менять саму задачу: исполнителю нужно
        отмечать прогресс, но не переписывать условие.
        """
        if user.role is UserRole.ADMIN:
            return True
        if card.is_assignee(user.user_id):
            return True
        return user.role is UserRole.TEAM_LEAD and str(card.created_by) == str(user.user_id)

    def _assert_can_view(self, card: Card, user: User) -> None:
        if not self._can_view(card, user):
            # 404, а не 403: не подтверждаем существование чужой карточки.
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

    def _assert_can_manage(self, card: Card, user: User) -> None:
        # Сначала видимость: тому, кто карточку видеть не должен,
        # отвечаем 404 и не выдаём фактом 403, что она существует.
        self._assert_can_view(card, user)
        if not self._can_manage(card, user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='Изменять задачу может только её автор или администратор.',
            )

    def _assert_can_comment(self, card: Card, user: User) -> None:
        self._assert_can_view(card, user)

    @staticmethod
    def _can_edit_attachments(card: Card, user: User) -> bool:
        """
        Право менять именно вложения (добавлять/удалять/загружать файлы).
        Из всей карточки это единственное поле, доступное не только
        админу и автору: им может распоряжаться ещё и исполнитель —
        но только если он действительно назначен на карточку.
        Быть постановщиком, не будучи при этом исполнителем, для
        вложений недостаточно — на остальные поля карточки это право
        не распространяется (см. _can_manage).

        Автор задачи входит сюда всегда, даже если сам не назначен
        исполнителем: раз он владеет условием задачи, он владеет и
        приложенными к нему файлами.
        """
        if user.role is UserRole.ADMIN:
            return True
        if str(card.created_by) == str(user.user_id):
            return True
        return card.is_assignee(user.user_id)

    def _assert_can_edit_attachments(self, card: Card, user: User) -> None:
        self._assert_can_view(card, user)
        if not self._can_edit_attachments(card, user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='Управлять вложениями может только автор задачи, назначенный на неё исполнитель или администратор.',
            )

    async def _card_ctx(self, card: Card) -> dict:
        """Человекочитаемый контекст карточки для журнала действий."""
        col = await self.column_repo.get_by_id(card.column_id)
        project = await self.project_repo.get_by_id(card.project_id) if card.project_id else None
        return {
            'card_title': card.title,
            'column_name': col.name if col else None,
            'project_id': card.project_id,
            'project_name': project.name if project else None,
        }

    def _visible_subset(self, cards: list[Card], user: User) -> list[Card]:
        return [c for c in cards if self._can_view(c, user)]

    async def _resolve_assignees(self, assignee_ids: list[uuid.UUID]) -> list[User]:
        if not assignee_ids:
            return []
        users = await self.user_repo.get_users_by_ids(assignee_ids)
        found = {u.user_id for u in users}
        missing = [str(uid) for uid in assignee_ids if uid not in found]
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f'Исполнитель не найден: {", ".join(missing)}',
            )
        inactive = [u.username for u in users if not u.is_active]
        if inactive:
            raise HTTPException(
                status_code=400,
                detail=f'Нельзя назначить деактивированного пользователя: {", ".join(inactive)}',
            )
        return users

    async def _notify_assignees(self, card: Card, user_ids: set[uuid.UUID], actor: User) -> None:
        for uid in user_ids:
            if str(uid) == str(actor.user_id):
                continue
            notif_msg = {
                'event': 'notification',
                'payload': {
                    'card_title': card.title,
                    'from_user': actor.username,
                    'priority': card.priority,
                    'type': 'assigment',
                },
            }
            delivered = await manager.send_personal_message(str(uid), notif_msg)
            if not delivered:
                await self.notif_repo.ensure_notification_exists(uid, card.id)

    STATUS_LABELS = {
        CardStatus.NOT_STARTED: 'не начата',
        CardStatus.IN_PROGRESS: 'взята в работу',
        CardStatus.PAUSED: 'на паузе',
        CardStatus.REVIEW: 'проверка',
        CardStatus.REWORK: 'доработка',
        CardStatus.DONE: 'готово',
    }

    @classmethod
    def _status_label(cls, value) -> str:
        try:
            return cls.STATUS_LABELS[CardStatus(value)]
        except (ValueError, KeyError):
            return str(value)

    #======================================================
    # Cards
    #======================================================
    async def get_all(
            self,
            viewer: User,
            column_id: uuid.UUID | None = None,
            assigned_to: uuid.UUID | None = None,
            project_ids: list[uuid.UUID] | None = None,
    ) -> list[CardOut]:
        # Фильтр видимости навязывается сервером и не зависит от
        # параметров запроса: клиент не может расширить себе выдачу.
        visible_for = None if viewer.role is UserRole.ADMIN else viewer.user_id
        cards = await self.repo.get_all(
            column_id=column_id,
            assigned_to=assigned_to,
            visible_for=visible_for,
            # Созданное собой видит любая роль: у постановщика это его
            # задачи, у исполнителя — личные, заведённые им самим.
            include_own_created=True,
            project_ids=project_ids,
        )
        return [CardOut.model_validate(c) for c in cards]

    async def get_one(self, card_id: uuid.UUID, viewer: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_view(card, viewer)
        return CardOut.model_validate(card)

    async def search(self, query: str, viewer: User) -> list[CardOut]:
        """
        Быстрый поиск задачи по номеру или по названию.

        Область — всё, что зрителю в принципе видно (та же видимость,
        что и на доске), без привязки к текущему открытому проекту:
        номер задачи уникален по всей системе, поэтому искать её нужно
        сквозь проекты, а не только в рамках одного.
        """
        q = (query or '').strip()
        if not q:
            return []

        all_cards = await self.get_all(viewer)

        q_lower = q.lower()
        # Пользователь видит номера с префиксом T (T42), поэтому поиск
        # должен понимать и его, и голое число.
        number_part = q_lower[1:] if q_lower.startswith('t') else q_lower
        by_number = number_part if number_part.isdigit() else None

        matched = [
            c for c in all_cards
            if (by_number is not None and str(c.number) == by_number)
            or q_lower in c.title.lower()
        ]
        # Точное совпадение по номеру — самый однозначный запрос,
        # поэтому ставим его первым.
        matched.sort(key=lambda c: (by_number is None or str(c.number) != by_number, c.number))
        return matched[:30]

    async def create(self, data: CardCreate, author: User) -> CardOut:
        col = await self.column_repo.get_by_id(data.column_id)
        if not col:
            raise HTTPException(status_code=404, detail="Колонка не найдена.")

        # Проект берём из колонки, а не из тела запроса: так карточка
        # физически не может оказаться в чужом проекте.
        from app.services.project_service import ProjectService
        project_service = ProjectService(self.session)

        card_project = await project_service.assert_can_view(col.project_id, author)

        if author.role is UserRole.ADMIN or await project_service.can_manage_project(
            card_project, author
        ):
            pass  # админ и постановщик проекта заводят задачи как обычно
        elif col.is_user_creatable and await project_service.is_project_member(
            card_project, author
        ):
            # Личную задачу заводит только ответственный этого узла дерева.
            # Ответственный за родительский проект здесь посторонний,
            # даже если категория открыта.
            pass
        else:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='В этой категории вы не можете создавать задачи.',
            )

        if author.is_manager:
            requested_ids = list(data.assignee_ids)
        else:
            # Личная задача исполнителя: состав жёстко равен автору.
            # Ни добавить коллегу, ни убрать себя он не может — иначе
            # задача уехала бы к тому, кто её не заводил.
            requested_ids = [author.user_id]

        assignees = await self._resolve_assignees(requested_ids)

        max_pos = await self.repo.get_max_position_in_column(data.column_id)
        card = await self.repo.create(
            title=data.title,
            column_id=data.column_id,
            position=max_pos + 1,
            created_by=author.user_id,
            description=data.description,
            deadline=data.deadline,
            priority=data.priority,
            assignees=assignees,
            project_id=col.project_id,
            status=data.status,
        )
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self._notify_assignees(card, {u.user_id for u in assignees}, author)

        project = await self.project_repo.get_by_id(col.project_id)
        who = ', '.join(u.username for u in assignees) or 'без исполнителя'
        await self.event_repo.create(
            event_type=EventType.CARD_CREATED,
            message=f"Создал задачу «{card.title}» в категории «{col.name}» ({who})",
            card_id=card.id,
            actor=author,
            card_title=card.title,
            column_name=col.name,
            project_id=col.project_id,
            project_name=project.name if project else None,
            payload=payload
        )
        await manager.publish('card_created', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Card created: {card.id, card.title}')
        return out

    async def update(self, card_id: uuid.UUID, data: CardUpdate, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

        sent_fields = data.model_fields_set

        # Если пытаются изменить основные поля карточки (заголовок, описание, дедлайн, приоритет, колонка)
        restricted_fields = {'title', 'description', 'deadline', 'priority', 'column_id'}
        if sent_fields.intersection(restricted_fields):
            self._assert_can_manage(card, actor) # Только Автор/Админ
        else:
            # Для остальных полей (например, исполнителей) достаточно быть хотя бы исполнителем/автором/админом
            self._assert_can_view(card, actor)
            if not (self._can_manage(card, actor) or card.is_assignee(actor.user_id)):
                raise HTTPException(status_code=403, detail='Недостаточно прав для изменения задачи.')
            
        self._assert_can_manage(card, actor)

        updates: dict = {}
        log_details = []
        sent_fields = data.model_fields_set

        old_assignee_ids = {u.user_id for u in card.assignees}
        new_assignee_ids = old_assignee_ids

        old_title = card.title
        if 'title' in sent_fields and data.title is not None and data.title != card.title:
            updates['title'] = data.title
            log_details.append(f'название → «{data.title}»')

        if 'description' in sent_fields and data.description != card.description:
            updates['description'] = data.description
            log_details.append('обновлено описание')

        if 'deadline' in sent_fields and data.deadline != card.deadline:
            updates['deadline'] = data.deadline
            date_str = data.deadline.strftime('%d.%m.%Y') if data.deadline else 'снят'
            log_details.append(f'дедлайн: {date_str}')

        if 'status' in sent_fields and data.status is not None and data.status != card.status:
            updates['status'] = data.status
            log_details.append(f'статус → {self._status_label(data.status)}')

        if 'priority' in sent_fields and data.priority is not None and data.priority != card.priority:
            updates['priority'] = data.priority
            p_raw = data.priority.value if hasattr(data.priority, 'value') else str(data.priority)
            p_name = {'HIGHT': 'высокий', 'MEDIUM': 'средний', 'LOW': 'низкий'}.get(p_raw, p_raw)
            log_details.append(f'приоритет → {p_name}')

        # Исполнители: полная замена списка
        assignees_changed = False
        if ('assignee_ids' in sent_fields and data.assignee_ids is not None
                and not actor.is_manager
                and set(data.assignee_ids) != old_assignee_ids):
            # Состав исполнителей личной задачи неизменен: её автор
            # остаётся единственным исполнителем.
            # Сравниваем со старым составом, а не просто с фактом присылки
            # поля: форма редактирования отправляет карточку целиком, и
            # неизменный список исполнителей не должен ронять сохранение.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='В собственной задаче нельзя менять исполнителей.',
            )

        if 'assignee_ids' in sent_fields and data.assignee_ids is not None:
            requested = set(data.assignee_ids)
            if requested != old_assignee_ids:
                users = await self._resolve_assignees(data.assignee_ids)
                new_assignee_ids = {u.user_id for u in users}
                assignees_changed = True
                if users:
                    log_details.append(f"исполнители → {', '.join(u.username for u in users)}")
                else:
                    log_details.append('исполнители сняты')

        event_type = EventType.CARD_EDITED
        original_column_id = card.column_id

        if 'column_id' in sent_fields and data.column_id is not None and data.column_id != card.column_id:
            target_col = await self.column_repo.get_by_id(data.column_id)
            if not target_col:
                raise HTTPException(status_code=404, detail='Целевая категория не найдена.')
            if target_col.project_id != card.project_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail='Нельзя перенести задачу в категорию другого проекта.',
                )

            max_pos = await self.repo.get_max_position_in_column(data.column_id)
            updates['column_id'] = data.column_id
            updates['position'] = max_pos + 1

            event_type = EventType.CARD_MOVED
            log_details.append(f'перенесена в категорию «{target_col.name}»')

        if not updates and not assignees_changed:
            return CardOut.model_validate(card)

        if assignees_changed:
            await self.repo.set_assignees(card, list(new_assignee_ids))

        if updates:
            card = await self.repo.update(card, **updates)
        else:
            card = await self.repo.get_by_id(card.id)

        if event_type == EventType.CARD_MOVED:
            await self.repo.normalize_position_in_column(original_column_id)

        # Уведомления только новым исполнителям
        added = new_assignee_ids - old_assignee_ids
        removed = old_assignee_ids - new_assignee_ids
        if added:
            await self._notify_assignees(card, added, actor)
        for uid in removed:
            await self.notif_repo.delete_specific_notification(uid, card.id)

        final_message = '; '.join(log_details)

        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        ctx = await self._card_ctx(card)
        await self.event_repo.create(
            event_type=event_type,
            message=(f'Изменил задачу «{old_title}»: {final_message}'
                     if final_message else f'Изменил задачу «{old_title}»'),
            card_id=card.id,
            actor=actor,
            payload=payload,
            **ctx,
        )

        ws_event = "card_moved" if event_type == EventType.CARD_MOVED else "card_updated"
        await manager.publish(ws_event, str(card.id), payload, audience=self._audience(card))

        # Снятым исполнителям карточка больше не видна — говорим их клиентам
        # убрать её с доски, иначе она зависнет до перезагрузки страницы.
        if removed:
            await manager.publish(
                'card_unassigned',
                str(card.id),
                {'id': str(card.id)},
                audience={str(u) for u in removed},
                include_privileged=False,
            )

        await self.session.commit()
        return out

    async def delete(self, card_id: uuid.UUID, actor: User) -> None:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        audience = self._audience(card)

        stmt = select(Attachment).where(Attachment.card_id == card_id)
        result = await self.session.execute(stmt)
        attachments = result.scalars().all()

        for at in attachments:
            if at.file_path and os.path.exists(at.file_path):
                try:
                    os.remove(at.file_path)
                    logger.info(f"File deleted from disk: {at.file_path}")
                except Exception as e:
                    logger.error(f"Error deleting file {at.file_path}: {e}")

        column_id = card.column_id
        title = card.title
        del_project_id = card.project_id
        _del_project = await self.project_repo.get_by_id(card.project_id) if card.project_id else None
        del_project_name = _del_project.name if _del_project else None
        await self.notif_repo.delete_by_card(card_id)
        await self.repo.delete(card)
        await self.repo.normalize_position_in_column(column_id)

        payload = {'id': str(card_id)}
        await self.event_repo.create(
            event_type=EventType.CARD_DELETED,
            message=f"Удалил задачу «{title}»"
                    + (f" из проекта «{del_project_name}»" if del_project_name else ''),
            card_id=None,
            actor=actor,
            card_title=title,
            project_id=del_project_id,
            project_name=del_project_name,
        )
        await manager.publish('card_deleted', str(card_id), payload, audience=audience)
        await self.session.commit()

        logger.info(f'Card deleted: {card_id}')

    def _resolve_absolute_position(
        self,
        ordered_cards: list[Card],
        actor: User,
        visible_position: int,
    ) -> int:
        """
        Переводит позицию из системы координат клиента в абсолютную.

        Клиент присылает индекс внутри того списка, который видит сам.
        У постановщика и исполнителя это подмножество колонки, поэтому
        принимать число как абсолютную позицию нельзя: карточка уехала бы
        мимо места, куда её бросили, и порядок у остальных поехал бы.

        ordered_cards — все карточки целевой колонки по возрастанию position,
        без перемещаемой. Возвращает индекс вставки в этот полный список.
        """
        if actor.role is UserRole.ADMIN:
            return min(visible_position, len(ordered_cards))

        visible = self._visible_subset(ordered_cards, actor)

        # Бросили ниже последней видимой карточки — значит в конец колонки.
        if visible_position >= len(visible):
            return len(ordered_cards)

        # Иначе встаём прямо перед той видимой карточкой,
        # которая сейчас занимает это место.
        anchor = visible[visible_position]
        return ordered_cards.index(anchor)

    async def move(self, card_id: uuid.UUID, data: CardMoveRequest, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

        self._assert_can_view(card, actor)

        target_col = await self.column_repo.get_by_id(data.target_column_id)
        if not target_col:
            raise HTTPException(status_code=404, detail='Целевая категория не найдена.')
        if target_col.project_id != card.project_id:
            # Доски проектов независимы: перетаскивание между ними
            # означало бы смену принадлежности задачи втихую.
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail='Задачу нельзя перетащить в другой проект.',
            )

        source_column_id = card.column_id
        same_column = source_column_id == data.target_column_id

        # Автор задачи и админ таскают её куда угодно. Тот, кто просто
        # назначен исполнителем, ограничен списком разрешённых категорий —
        # даже если он постановщик, но задачу создал не он.
        unrestricted = self._can_manage(card, actor)

        if not unrestricted and not same_column and not target_col.is_user_movable:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Перемещение в категорию '{target_col.name}' вам недоступно.",
            )

        if same_column:
            cards = await self.repo.get_by_column_ordered(source_column_id)
            cards = [c for c in cards if c.id != card_id]

            target_pos = self._resolve_absolute_position(cards, actor, data.target_position)
            cards.insert(target_pos, card)

            for idx, c in enumerate(cards):
                c.position = idx
            await self.session.flush()

        else:
            source_cards = await self.repo.get_by_column_ordered(source_column_id)
            source_cards = [c for c in source_cards if c.id != card_id]
            for idx, c in enumerate(source_cards):
                c.position = idx

            target_cards = await self.repo.get_by_column_ordered(data.target_column_id)
            target_pos = self._resolve_absolute_position(target_cards, actor, data.target_position)

            for c in target_cards:
                if c.position >= target_pos:
                    c.position += 1

            card.column_id = data.target_column_id
            card.position = target_pos
            await self.session.flush()

        card.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

        card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        source_col = await self.column_repo.get_by_id(source_column_id)
        src_name = source_col.name if source_col else '—'
        if same_column:
            log_msg = f"Изменил порядок задачи «{card.title}» в категории «{target_col.name}»"
        else:
            log_msg = (f"Перенёс задачу «{card.title}» из категории «{src_name}» "
                       f"в «{target_col.name}»")

        project = await self.project_repo.get_by_id(card.project_id) if card.project_id else None
        await self.event_repo.create(
            event_type=EventType.CARD_MOVED,
            message=log_msg,
            card_id=card.id,
            actor=actor,
            card_title=card.title,
            column_name=target_col.name,
            project_id=card.project_id,
            project_name=project.name if project else None,
            payload=payload
        )

        await manager.publish('card_moved', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Card moved: {card_id} -> column {data.target_column_id} pos {card.position}')
        return out

    async def change_status(self, card_id: uuid.UUID, data: CardStatusUpdate, actor: User) -> CardOut:
        """Смена стадии работы — отдельно от общего редактирования задачи."""
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')

        self._assert_can_view(card, actor)
        if not self._can_change_status(card, actor):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail='Менять статус может исполнитель задачи, её автор или администратор.',
            )

        if card.status == data.status:
            return CardOut.model_validate(card)

        old_label = self._status_label(card.status)
        new_label = self._status_label(data.status)

        card = await self.repo.update(card, status=data.status)
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.CARD_STATUS_CHANGED,
            message=f'Задача «{card.title}»: статус «{old_label}» → «{new_label}»',
            card_id=card.id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(card)),
        )

        await manager.publish('card_updated', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Card {card_id} status: {old_label} -> {new_label} by {actor.username}')
        return out

    async def archive(self, card_id: uuid.UUID, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        card.is_archived = True
        await self.session.flush()
        card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.CARD_ARCHIVED,
            message=f'Отправил задачу «{card.title}» в архив',
            card_id=card_id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(card)),
        )

        await manager.publish('card_archived', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        return out

    async def unarchive(self, card_id: uuid.UUID, actor: User) -> CardOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_manage(card, actor)

        card.is_archived = False
        await self.session.flush()
        card = await self.repo.get_by_id(card_id)

        out = CardOut.model_validate(card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.CARD_RESTORED,
            message=f'Вернул задачу «{card.title}» из архива',
            card_id=card.id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(card)),
        )

        await manager.publish('card_restored', str(card.id), payload, audience=self._audience(card))
        await self.session.commit()
        return out

    #======================================================
    # Attachments
    #======================================================
    async def get_attachment(self, attachment_id: uuid.UUID) -> Attachment:
        stmt = select(Attachment).where(Attachment.id == attachment_id)
        result = await self.session.execute(stmt)
        attachment = result.scalar_one_or_none()

        if not attachment:
            logger.warning(f"Attachment {attachment_id} not found in DB")
            raise HTTPException(status_code=404, detail="Вложение не найдено.")

        return attachment

    async def get_attachment_file_response(self, attachment_id: uuid.UUID, viewer: User) -> FileResponse:
        attachment = await self.get_attachment(attachment_id)

        card = await self.repo.get_by_id(attachment.card_id)
        if card:
            self._assert_can_view(card, viewer)

        if not attachment.file_path or not os.path.exists(attachment.file_path):
            logger.error(f"File missing on disk: {attachment.file_path}")
            raise HTTPException(status_code=404, detail="Файл физически отсутствует на сервере.")

        return FileResponse(
            path=attachment.file_path,
            filename=attachment.filename,
            media_type=attachment.content_type
        )

    async def get_card_attachments(self, card_id: uuid.UUID, viewer: User) -> list[Attachment]:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail="Карточка не найдена.")
        self._assert_can_view(card, viewer)

        stmt = select(Attachment).where(Attachment.card_id == card_id)
        result = await self.session.execute(stmt)
        return result.scalars().all()

    async def upload_card_file(self, card_id: uuid.UUID, file: UploadFile, actor: User):
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail="Карточка не найдена.")
        self._assert_can_edit_attachments(card, actor)

        count = await self.repo.get_attachment_count(card_id)
        if count >= 5:
            raise HTTPException(status_code=400, detail="Максимум 5 файлов на карточку.")

        MAX_SIZE = 5 * 1024 * 1024
        file_content = await file.read()
        if len(file_content) > MAX_SIZE:
            raise HTTPException(status_code=413, detail="Файл слишком большой (максимальный размер файла 5MB).")

        file_extension = os.path.splitext(file.filename)[1]
        unique_filename = f'{card_id}_{os.urandom(4).hex()}{file_extension}'
        file_path = os.path.join(UPLOAD_DIR, unique_filename)

        with open(file_path, 'wb') as buffer:
            buffer.write(file_content)

        attachment_data = {
            'card_id': card_id,
            'filename': file.filename,
            'stored_filename': unique_filename,
            'file_path': file_path,
            'content_type': file.content_type
        }
        attachment = await self.repo.add_attachment(attachment_data)
        updated_card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(updated_card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.ATTACHMENT_ADDED,
            message=f'Прикрепил файл «{file.filename}» к задаче «{updated_card.title}»',
            card_id=card_id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(updated_card)),
        )

        await manager.publish('card_updated', str(card_id), payload, audience=self._audience(updated_card))

        await self.session.commit()
        logger.info(f"Attachment saved to DB: {attachment.id} for card {card_id}")
        return attachment

    async def delete_attachment(self, attachment_id: uuid.UUID, actor: User):
        attachment = await self.repo.get_attachment_by_id(attachment_id)
        if not attachment:
            raise HTTPException(status_code=404, detail="Вложение не найдено")

        card_id = attachment.card_id
        card = await self.repo.get_by_id(card_id)
        if card:
            self._assert_can_edit_attachments(card, actor)

        try:
            if attachment.file_path and os.path.exists(attachment.file_path):
                os.remove(attachment.file_path)
                logger.info(f"Attachment successfully deleted: {attachment.file_path}")
            else:
                logger.warning(f"File not found. Skip deleting file: {attachment.file_path}")
        except Exception as e:
            logger.error(f"Error while deleting file {attachment.file_path}: {e}")

        filename = attachment.filename
        await self.repo.delete_attachment(attachment_id)
        await self.session.flush()

        updated_card = await self.repo.get_by_id(card_id)
        out = CardOut.model_validate(updated_card)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.ATTACHMENT_DELETED,
            message=f'Удалил файл «{filename}» из задачи «{updated_card.title}»',
            card_id=card_id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(updated_card)),
        )

        await manager.publish('card_updated', str(card_id), payload, audience=self._audience(updated_card))
        await self.session.commit()
        return {'status': 'success'}

    #======================================================
    # Comments
    #======================================================
    async def add_comment(self, card_id: uuid.UUID, actor: User, text: str) -> CommentOut:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_comment(card, actor)

        comment = await self.repo.add_comment(card_id, actor.user_id, text)
        out = CommentOut.model_validate(comment)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.COMMENT_ADDED,
            message=f'Прокомментировал задачу «{card.title}»: '
                    f"{text[:80]}{'…' if len(text) > 80 else ''}",
            card_id=card_id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(card)),
        )

        await manager.publish('comment_created', str(card_id), payload, audience=self._audience(card))
        await self.session.commit()
        logger.info(f'Comment {comment.id} added to card {card_id} by user {actor.user_id}')
        return out

    async def edit_comment(self, comment_id: uuid.UUID, actor: User, new_text: str) -> CommentOut:
        comment = await self.repo.get_comment_by_id(comment_id)
        if not comment:
            raise HTTPException(status_code=404, detail='Комментарий не существует.')

        if str(comment.user_id) != str(actor.user_id):
            logger.warning(f'User {actor.user_id} tried to edit comment {comment_id} owned by {comment.user_id}')
            raise HTTPException(status_code=403, detail='Вы не можете редактировать чужой комментарий.')

        card = await self.repo.get_by_id(comment.card_id)
        updated_comment = await self.repo.edit_comment(comment_id, new_text)
        out = CommentOut.model_validate(updated_comment)
        payload = out.model_dump(mode='json')

        await self.event_repo.create(
            event_type=EventType.COMMENT_EDITED,
            message=f'Изменил свой комментарий к задаче «{card.title if card else "—"}»',
            card_id=comment.card_id,
            actor=actor,
            payload=payload,
            **(await self._card_ctx(card) if card else {}),
        )
        await manager.publish(
            'comment_updated', str(comment.card_id), payload,
            audience=self._audience(card) if card else None,
        )

        await self.session.commit()
        logger.info(f"Comment {comment_id} updated by user {actor.user_id}")
        return out

    async def delete_comments(self, comment_id: uuid.UUID, actor: User) -> None:
        comment = await self.repo.get_comment_by_id(comment_id)
        if not comment:
            raise HTTPException(status_code=404, detail='Комментарий не существует.')

        # Свой комментарий удаляет автор комментария.
        # Чужой — админ или автор самой задачи (модерация своей задачи).
        card_for_perm = await self.repo.get_by_id(comment.card_id)
        may_moderate = card_for_perm is not None and self._can_manage(card_for_perm, actor)
        if str(comment.user_id) != str(actor.user_id) and not may_moderate:
            logger.warning(f'User {actor.user_id} tried to delete comment {comment_id} owned by {comment.user_id}')
            raise HTTPException(status_code=403, detail='Вы не можете удалить чужой комментарий.')

        card_id = comment.card_id
        card = await self.repo.get_by_id(card_id)
        await self.repo.delete_comment(comment)
        payload = {'id': str(comment_id), 'card_id': str(card_id)}

        await self.event_repo.create(
            event_type=EventType.COMMENT_DELETED,
            message=f'Удалил комментарий'
                    + (f' к задаче «{card.title}»' if card else '')
                    + ('' if str(comment.user_id) == str(actor.user_id)
                       else f' (автор: {comment.author.username})'),
            card_id=card_id,
            actor=actor,
            payload=payload,
            target_username=None if str(comment.user_id) == str(actor.user_id) else comment.author.username,
            **(await self._card_ctx(card) if card else {}),
        )

        await manager.publish(
            'comment_deleted', str(card_id), payload,
            audience=self._audience(card) if card else None,
        )
        await self.session.commit()
        logger.info(f"Comment {comment_id} deleted by user {actor.user_id}")
        return {"status": "success"}

    async def get_comments(self, card_id: uuid.UUID, viewer: User, last_id: uuid.UUID | None = None) -> list[CommentOut]:
        card = await self.repo.get_by_id(card_id)
        if not card:
            raise HTTPException(status_code=404, detail='Карточка не найдена.')
        self._assert_can_view(card, viewer)

        comments = await self.repo.get_comments_paginated(card_id, last_id)
        return [CommentOut.model_validate(c) for c in comments]