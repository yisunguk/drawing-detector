import asyncio
import os
import urllib.parse
import requests
from app.core.config import settings
from app.services.blob_storage import get_container_client
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from datetime import datetime, timedelta

def debug_sas():
    try:
        print("1. Listing blobs to find a candidate...")
        try:
             container_client = get_container_client()
             blobs_iter = container_client.list_blobs(results_per_page=5)
             blobs = []
             for b in blobs_iter:
                 blobs.append(b)
                 if len(blobs) >= 1: break
        except Exception as e:
            print(f"Failed to list blobs: {e}")
            return

        if not blobs:
            print("No blobs found.")
            return

        # Pick a PDF if possible, or any file
        target_blob = next((b for b in blobs if b.name.endswith('.pdf')), blobs[0])
        blob_name = target_blob.name
        print(f"Target Blob: {blob_name}")

        print("2. Generating SAS Token...")
        account_name = container_client.account_name
        account_key = None
        
        # Logic from RobustAnalysisManager
        if hasattr(container_client.credential, 'account_key'):
            account_key = container_client.credential.account_key
        elif isinstance(container_client.credential, dict) and 'account_key' in container_client.credential:
            account_key = container_client.credential['account_key']
        else:
            conn_str = os.environ.get("AZURE_BLOB_CONNECTION_STRING") or settings.AZURE_BLOB_CONNECTION_STRING
            if conn_str:
                for part in conn_str.split(';'):
                    if 'AccountKey=' in part:
                        account_key = part.split('AccountKey=')[1]
                        break
        
        sas_token = None
        if account_key:
            sas_token = generate_blob_sas(
                account_name=account_name,
                container_name=settings.AZURE_BLOB_CONTAINER_NAME,
                blob_name=blob_name,
                account_key=account_key,
                permission=BlobSasPermissions(read=True),
                expiry=datetime.utcnow() + timedelta(hours=1)
            )
        else:
             print("No Account Key found! Using SAS from settings?")
             sas_token = settings.AZURE_BLOB_SAS_TOKEN
        
        if not sas_token:
            print("Failed to generate SAS token.")
            return

        # URL Encoding test
        encoded_blob_name = urllib.parse.quote(blob_name, safe="/~()-_.")
        blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{encoded_blob_name}?{sas_token}"
        
        print(f"Generated URL: {blob_url}")

        print("3. Testing HEAD Request...")
        response = requests.head(blob_url)
        print(f"HEAD Status Code: {response.status_code}")
        print(f"Headers: {response.headers}")
        
        if 'Content-Length' in response.headers:
             print(f"Content-Length: {response.headers['Content-Length']} bytes ({int(response.headers['Content-Length'])/1024/1024:.2f} MB)")
        
        if response.status_code == 200:
            print("SUCCESS: 200 OK")
        elif response.status_code == 403:
            print("FAILURE: 403 Forbidden (SAS or IP issue)")
        elif response.status_code == 404:
            print("FAILURE: 404 Not Found (Path issue)")
        else:
            print(f"FAILURE: {response.status_code}")

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    from dotenv import load_dotenv
    # Explicitly load backend/.env
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    print(f"Loading .env from {env_path}")
    load_dotenv(env_path)
    debug_sas()
