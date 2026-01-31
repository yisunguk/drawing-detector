from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
import io

router = APIRouter()

def get_container_client():
    if not settings.AZURE_BLOB_CONNECTION_STRING and not (settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN):
        raise HTTPException(status_code=500, detail="Azure Storage not configured")
    
    blob_service_client = None
    
    blob_service_client = None
    
    # Method 1: Try Explicit Account Name + SAS Token (Preferred)
    if not blob_service_client and settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN:
        try:
            # Fix common gcloud escaping issue where comma must be encoded as %2C
            sas_token = settings.AZURE_BLOB_SAS_TOKEN.replace("%2C", ",")
            
            account_url = f"https://{settings.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net"
            blob_service_client = BlobServiceClient(account_url, credential=sas_token)
        except Exception as e:
            print(f"Warning: SAS Token auth failed ({e}), trying connection string.")
            blob_service_client = None

    # Method 2: Fallback to Connection String
    if not blob_service_client and settings.AZURE_BLOB_CONNECTION_STRING and ("DefaultEndpointsProtocol" in settings.AZURE_BLOB_CONNECTION_STRING or "SharedAccessSignature" in settings.AZURE_BLOB_CONNECTION_STRING):
        try:
            blob_service_client = BlobServiceClient.from_connection_string(settings.AZURE_BLOB_CONNECTION_STRING)
        except Exception as e:
            print(f"Warning: Connection string failed ({e})")
            blob_service_client = None
        
    return blob_service_client.get_container_client(settings.AZURE_BLOB_CONTAINER_NAME)

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
