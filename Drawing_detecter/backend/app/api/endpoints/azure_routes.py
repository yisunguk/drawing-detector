from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
import io

router = APIRouter()

def get_container_client():
    if not settings.AZURE_BLOB_CONNECTION_STRING and not (settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN):
        raise HTTPException(status_code=500, detail="Azure Storage not configured")
    
    if settings.AZURE_BLOB_CONNECTION_STRING:
        blob_service_client = BlobServiceClient.from_connection_string(settings.AZURE_BLOB_CONNECTION_STRING)
    else:
        account_url = f"https://{settings.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net"
        blob_service_client = BlobServiceClient(account_url, credential=settings.AZURE_BLOB_SAS_TOKEN)
        
    return blob_service_client.get_container_client(settings.AZURE_BLOB_CONTAINER_NAME)

@router.get("/list")
async def list_files(path: str = ""):
    try:
        container_client = get_container_client()
        prefix = path if path.endswith('/') or not path else path + '/'
        
        items = []
        folders = set()
        
        blobs = container_client.list_blobs(name_starts_with=path)
        for blob in blobs:
            relative_name = blob.name[len(path):].lstrip('/')
            if '/' in relative_name:
                folder_name = relative_name.split('/')[0]
                if folder_name not in folders:
                    folders.add(folder_name)
                    items.append({
                        "name": folder_name,
                        "type": "folder",
                        "path": (path.rstrip('/') + '/' + folder_name + '/') if path else (folder_name + '/')
                    })
            else:
                if relative_name:
                    items.append({
                        "name": relative_name,
                        "type": "file",
                        "path": blob.name,
                        "size": blob.size,
                        "last_modified": blob.last_modified.isoformat()
                    })
        return items
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/download")
async def download_file(path: str):
    try:
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(path)
        
        stream = blob_client.download_blob().readall()
        return StreamingResponse(io.BytesIO(stream), media_type="application/pdf")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
