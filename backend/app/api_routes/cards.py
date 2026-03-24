import uuid
from fastapi import APIRouter, Depends, Query, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.card_service import CardService
from app.db.schemas import  CardCreate, CardUpdate, CardMoveRequest, CardOut, AttachmentOut
from app.core.deps import get_current_user
from app.db.models import User

router = APIRouter(prefix='/cards', tags=['cards'])

@router.get('', response_model=list[CardOut])
async def list_cards(
    column_id: uuid.UUID | None = Query(default=None),
    assigned_to: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    return await CardService(db).get_all(column_id=column_id, assigned_to=assigned_to)

@router.post('', response_model=CardOut, status_code=status.HTTP_201_CREATED)
async def created_card(body: CardCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    body.created_by = current_user.user_id
    return await CardService(db).create(body)

@router.put('/{card_id}', response_model=CardOut)
async def update_card(card_id: uuid.UUID, body: CardUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).update(card_id, body, current_user.user_id)

@router.delete('/{card_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_card(card_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).delete(card_id)

@router.post('/{card_id}/move', response_model=CardOut)
async def move_card(card_id: uuid.UUID, body: CardMoveRequest, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).move(card_id, body)

@router.post('/{card_id}/attachments', response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_attachment(card_id: uuid.UUID, file: UploadFile, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).upload_card_file(card_id, file)

@router.get('/{card_id}/attachments/{attachment_id}/download')
async def download_attachment(
    card_id: uuid.UUID, 
    attachment_id: uuid.UUID, 
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    return await CardService(db).get_attachment_file_response(attachment_id)

@router.delete('/attachments/{attachment_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(attachment_id: uuid.UUID, db:AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).delete_attachment(attachment_id)