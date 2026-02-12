from fastapi import APIRouter, HTTPException, Depends, Header
from fastapi.responses import StreamingResponse
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
from azure.core.exceptions import ResourceNotFoundError
from app.services.blob_storage import get_container_client
import io

router = APIRouter()

# get_container_client is now imported from app.services.blob_storage

@router.get("/list")
def list_files(path: str = ""):
    try:
        print(f"DEBUG: list_files called with path='{path}'")
        # Use Synchronous Client
        container_client = get_container_client()
        
        # Sanitize path
        path = path.lstrip('/')
        if path and not path.endswith('/'):
            path += '/'
            
        print(f"DEBUG: listing blobs with prefix='{path}'")
        
        items = []
        
        # Synchronous walk_blobs
        blobs = container_client.walk_blobs(name_starts_with=path, delimiter='/')
        
        count = 0
        MAX_ITEMS = 1000
        
        for item in blobs:
            if count >= MAX_ITEMS:
                break
                
            if item.name.endswith('/'):
                # Folder
                folder_name_full = item.name.rstrip('/') 
                folder_name_display = folder_name_full.split('/')[-1]
                
                items.append({
                    "name": folder_name_display,
                    "type": "folder",
                    "path": item.name
                })
            else:
                # File
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
        print(f"Error in list_files: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/download")
def download_file(path: str, range: str = Header(None)):
    try:
        print(f"DEBUG: Download requested for path: '{path}' (Type: {type(path)})")
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(path)
        
        # Get blob properties for size (Synchronous)
        try:
            props = blob_client.get_blob_properties()
        except ResourceNotFoundError:
             print(f"Error: Blob not found at path: {path}")
             raise HTTPException(status_code=404, detail="File not found")

        file_size = props.size
        
        # Default to full download
        offset = 0
        length = None
        status_code = 200
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        }
        
        # Handle Range Header
        if range:
            try:
                start, end = range.replace("bytes=", "").split("-")
                start = int(start)
                end = int(end) if end else file_size - 1
                
                if start >= file_size:
                    raise HTTPException(status_code=416, detail="Requested Range Not Satisfiable")
                    
                offset = start
                length = end - start + 1
                status_code = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
                headers["Content-Length"] = str(length)
            except ValueError:
                pass 
        
        # Download stream (Synchronous)
        try:
            download_stream = blob_client.download_blob(offset=offset, length=length)
        except ResourceNotFoundError:
             raise HTTPException(status_code=404, detail="File not found during download")
        
        # Synchronous generator with explicit chunk handling
        def stream_generator():
            # Iterate chunks cleanly
            for chunk in download_stream.chunks():
                yield chunk

        media_type = "application/pdf"
        if path.lower().endswith(".json"):
            media_type = "application/json"
            
        return StreamingResponse(
            stream_generator(), 
            status_code=status_code, 
            headers=headers, 
            media_type=media_type
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in download_file: {e}")
        # If headers already sent, this might be swallowed, but ensuring we catch startup errors
        raise HTTPException(status_code=500, detail=str(e))
