import uuid
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Notification

class NotificationRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def ensure_notification_exists(self, user_id: uuid.UUID, card_id: uuid.UUID | None = None) -> None:
        query = select(Notification).where(Notification.user_id == user_id)
        result = await self.session.execute(query)
        existinf_notif = result.scalar_one_or_none()

        if not existinf_notif:
            new_notif = Notification(
                user_id=user_id,
                card_id=card_id,
                title='У вас есть новые задачи'
            )
            self.session.add(new_notif)
            await self.session.flush()
            return new_notif
    
    async def get_all_for_user(self, user_id: uuid.UUID) -> Notification:
        query = select(Notification).where(Notification.user_id == user_id)
        result = await self.session.execute(query)
        return result.scalars().first() is not None
    
    async def delete_specific_notification(self, user_id: uuid.UUID, card_id: uuid.UUID):
        query = delete(Notification).where(
            Notification.user_id == user_id,
            Notification.card_id == card_id
        )
        await self.session.execute(query)
    
    async def delete_by_card(self, card_id: uuid.UUID):
        query = delete(Notification).where(Notification.card_id == card_id)
        await self.session.execute(query)
        await self.session.flush()
    
    async def delete_all_for_user(self, user_id: uuid.UUID) -> None:
        query = delete(Notification).where(Notification.user_id == user_id)
        await self.session.execute(query)
        await self.session.commit()