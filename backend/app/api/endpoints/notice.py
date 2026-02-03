from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import json
from pathlib import Path
import os

router = APIRouter()

NOTICE_FILE = Path("data/notice.json")

# Ensure data directory exists
if not NOTICE_FILE.parent.exists():
    NOTICE_FILE.parent.mkdir(parents=True, exist_ok=True)

class Notice(BaseModel):
    content: str
    is_active: bool = True

@router.get("/")
async def get_notice():
    if not NOTICE_FILE.exists():
        return {"content": "", "is_active": False}
    
    try:
        with open(NOTICE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data
    except Exception as e:
        print(f"Error reading notice file: {e}")
        return {"content": "", "is_active": False}

@router.post("/")
async def update_notice(notice: Notice):
    try:
        with open(NOTICE_FILE, "w", encoding="utf-8") as f:
            json.dump(notice.dict(), f, ensure_ascii=False, indent=2)
        return {"message": "Notice updated successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update notice: {str(e)}")
