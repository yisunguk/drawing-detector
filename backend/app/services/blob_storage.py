from fastapi import HTTPException
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
import logging

# Initialize logger
logger = logging.getLogger(__name__)

# Global singleton instance
_blob_service_client = None

def get_blob_service_client():
    """
    Factory function to get or create the BlobServiceClient singleton.
    Implements the Lazy Initialization pattern to ensure the client is created only once.
    """
    global _blob_service_client
    
    # Return existing instance if available
    if _blob_service_client:
        return _blob_service_client

    if not settings.AZURE_BLOB_CONNECTION_STRING and not (settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN):
        logger.error("Azure Storage not configured")
        raise HTTPException(status_code=500, detail="Azure Storage not configured")
    
    client = None
    
    # Method 1: Try Explicit Account Name + SAS Token (Preferred)
    if not client and settings.AZURE_STORAGE_ACCOUNT_NAME and settings.AZURE_BLOB_SAS_TOKEN:
        try:
            # Fix common gcloud escaping issue where comma must be encoded as %2C
            # Also strip any accidental whitespace/newlines from secret injection
            sas_token = settings.AZURE_BLOB_SAS_TOKEN.replace("%2C", ",").strip()
            
            account_url = f"https://{settings.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net"
            temp_client = BlobServiceClient(account_url, credential=sas_token)
            
            # Verify authentication immediately (Fail Fast) - Only needed on first creation
            temp_client.get_account_information()
            
            client = temp_client
            print("Successfully authenticated with SAS Token (Singleton initialized)")
            
        except Exception as e:
            print(f"Warning: SAS Token auth failed ({type(e).__name__}: {e}), trying connection string.")
            client = None

    # Method 2: Fallback to Connection String
    if not client and settings.AZURE_BLOB_CONNECTION_STRING:
        # Check basic validity markers
        conn_str = settings.AZURE_BLOB_CONNECTION_STRING.strip()
        if "DefaultEndpointsProtocol" in conn_str or "SharedAccessSignature" in conn_str:
            try:
                # Debug log (masked)
                print(f"DEBUG: Attempting Connection String (Length: {len(conn_str)})")
                temp_client = BlobServiceClient.from_connection_string(conn_str)
                
                # OPTIONAL: Verify connection string auth too?
                # temp_client.get_account_information() 
                
                client = temp_client
                print("Successfully authenticated with Connection String (Singleton initialized)")
            except Exception as e:
                print(f"Warning: Connection string failed ({e})")
                client = None
            
    if not client:
        raise HTTPException(status_code=500, detail="Could not create Azure Blob Client (Auth Failed)")
        
    # Assign to global singleton
    _blob_service_client = client
    return _blob_service_client

def get_container_client(container_name: str = None):
    """
    Helper to get the container client using the singleton service client.
    Allows overriding container_name, defaults to settings.
    """
    client = get_blob_service_client()
    
    target_container = container_name or settings.AZURE_BLOB_CONTAINER_NAME
    if not target_container:
        raise HTTPException(status_code=500, detail="Container name not configured")
        
    return client.get_container_client(target_container)
