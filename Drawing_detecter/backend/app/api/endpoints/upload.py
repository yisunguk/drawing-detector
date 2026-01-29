from fastapi import APIRouter, UploadFile, File
import shutil
from pathlib import Path

router = APIRouter()

@router.post("/")
async def upload_file(file: UploadFile = File(...)):
    upload_dir = Path("uploads")
    upload_dir.mkdir(exist_ok=True)
    destination = upload_dir / file.filename
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return {"filename": file.filename}
