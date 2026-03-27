import uuid
from fastapi import APIRouter, Body, Depends, Query, UploadFile, status, Response
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.services.card_service import CardService
from app.db.schemas import  CardCreate, CardUpdate, CardMoveRequest, CardOut, AttachmentOut, CommentOut, CommentCreate
from app.core.deps import get_current_user
from app.db.models import User

router = APIRouter(prefix='/cards', tags=['cards'])

@router.get('', response_model=list[CardOut])
async def list_cards(
    column_id: uuid.UUID | None = Query(default=None),
    assigned_to: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    sort_by: str = Query('position', regex='^(position|priority|deadline)$'),
    current_user: User = Depends(get_current_user)
):
    return await CardService(db).get_all(column_id=column_id, assigned_to=assigned_to, sort_by=sort_by)

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
    response = await CardService(db).get_attachment_file_response(attachment_id)
    response.headers["Cache-Control"] = "public, max-age=604800, immutable"

    return response
    
@router.delete('/attachments/{attachment_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(attachment_id: uuid.UUID, db:AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).delete_attachment(attachment_id)

@router.get('/{card_id}/comments', response_model=list[CommentOut])
async def create_comment(card_id: uuid.UUID, last_id: uuid.UUID | None = Query(None, description='ID для пагинации'), db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).get_comments(card_id, last_id)

@router.post('/{card_id}/comments', response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def add_comment(card_id: uuid.UUID, body: CommentCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).add_comment(card_id=card_id, user_id=current_user.user_id, text=body.text)

@router.patch('/comments/{comment_id}', response_model=CommentOut)
async def update_comment(
    comment_id: uuid.UUID, 
    text: str = Body(..., embed=True, min_length=1, max_length=1000), 
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(get_current_user)
    ):
    return await CardService(db).edit_comment(
        comment_id=comment_id,
        user_id=current_user.user_id,
        new_text=text
    )

@router.delete('/comment/{comment_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(comment_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await CardService(db).delete_comments(comment_id, current_user.user_id)
