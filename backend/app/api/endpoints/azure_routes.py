from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
from app.services.blob_storage import get_container_client
import io

router = APIRouter()

# get_container_client is now imported from app.services.blob_storage

@router.get("/list")
async def list_files(path: str = ""):
    try:
        container_client = get_container_client()
        # Sanitize path: Azure blob paths do not start with /
        path = path.lstrip('/')
        prefix = path if path.endswith('/') or not path else path + '/'
        
        items = []
        folders = set()
        
        # Use walk_blobs for efficient hierarchical listing (avoids fetching all recursive children)
        print(f"DEBUG: Listing path '{path}' with delimiter '/'")
        blobs = container_client.walk_blobs(name_starts_with=path, delimiter='/')
        
        count = 0
        MAX_ITEMS = 1000 # Safety limit
        
        for item in blobs:
            if count >= MAX_ITEMS:
                break
                
            if item.name.endswith('/'):
                # It's a prefix (folder)
                # Remove the trailing slash and the prefix path for the display name
                folder_name_full = item.name.rstrip('/') 
                folder_name_display = folder_name_full.split('/')[-1]
                
                # Check if it's strictly a child of current path (sanity check)
                items.append({
                    "name": folder_name_display,
                    "type": "folder",
                    "path": item.name # walk_blobs includes full prefix
                })
            else:
                # It's a blob (file)
                file_name_display = item.name.split('/')[-1]
                items.append({
                    "name": file_name_display,
                    "type": "file",
                    "path": item.name,
                    "size": item.size,
                    "last_modified": item.last_modified.isoformat() if item.last_modified else None
                })
            count += 1
            
        return items
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/download")
async def download_file(path: str):
    try:
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(path)
        
        stream = blob_client.download_blob().readall()
        
        media_type = "application/pdf"
        if path.lower().endswith(".json"):
            media_type = "application/json"
            
        return StreamingResponse(io.BytesIO(stream), media_type=media_type)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
