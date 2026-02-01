from fastapi import HTTPException
from app.core.config import settings
from azure.storage.blob import BlobServiceClient

def get_container_client():
    if not settings.AZURE_BLOB_CONNECTION_STRING and not (settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN):
        raise HTTPException(status_code=500, detail="Azure Storage not configured")
    
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
            
    if not blob_service_client:
        raise HTTPException(status_code=500, detail="Could not create Azure Blob Client")
        
    return blob_service_client.get_container_client(settings.AZURE_BLOB_CONTAINER_NAME)
