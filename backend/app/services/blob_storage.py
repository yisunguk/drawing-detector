from fastapi import HTTPException
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
from azure.storage.blob import BlobServiceClient

def get_container_client():
    if not settings.AZURE_BLOB_CONNECTION_STRING and not (settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN):
        raise HTTPException(status_code=500, detail="Azure Storage not configured")
    
    blob_service_client = None
    
    # Method 1: Try Explicit Account Name + SAS Token (Preferred)
    if not blob_service_client and settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN:
        try:
            # Fix common gcloud escaping issue where comma must be encoded as %2C
            # Also strip any accidental whitespace/newlines from secret injection
            sas_token = settings.AZURE_BLOB_SAS_TOKEN.replace("%2C", ",").strip()
            
            account_url = f"https://{settings.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net"
            temp_client = BlobServiceClient(account_url, credential=sas_token)
            
            # Verify authentication immediately to fail fast
            # Note: Removing timeout arg as it caused py-multipart/requests conflict in previous deployment
            temp_client.get_account_information()
            blob_service_client = temp_client
            print("Successfully authenticated with SAS Token")
        except Exception as e:
            print(f"Warning: SAS Token auth failed ({type(e).__name__}: {e}), trying connection string.")
            blob_service_client = None

    # Method 2: Fallback to Connection String
    if not blob_service_client and settings.AZURE_BLOB_CONNECTION_STRING and ("DefaultEndpointsProtocol" in settings.AZURE_BLOB_CONNECTION_STRING or "SharedAccessSignature" in settings.AZURE_BLOB_CONNECTION_STRING):
        try:
            # Strip whitespace from connection string too
            conn_str = settings.AZURE_BLOB_CONNECTION_STRING.strip()
            # Debug log (masked)
            print(f"DEBUG: Attempting Connection String (Length: {len(conn_str)})")
            blob_service_client = BlobServiceClient.from_connection_string(conn_str)
            print("Successfully authenticated with Connection String")
        except Exception as e:
            print(f"Warning: Connection string failed ({e})")
            blob_service_client = None
            
    if not blob_service_client:
        raise HTTPException(status_code=500, detail="Could not create Azure Blob Client (Auth Failed)")
        
    return blob_service_client.get_container_client(settings.AZURE_BLOB_CONTAINER_NAME)

    return blob_service_client.get_container_client(settings.AZURE_BLOB_CONTAINER_NAME)
