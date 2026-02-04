import requests
import json
from azure.storage.blob import BlobServiceClient
from app.core.config import settings
import os

# Manual Config if env vars not set locally
CONNECTION_STRING = os.getenv("AZURE_BLOB_CONNECTION_STRING") or "DefaultEndpointsProtocol=https;AccountName=drawingdetector;AccountKey=...;EndpointSuffix=core.windows.net"

def get_container_client():
    blob_service_client = BlobServiceClient.from_connection_string(CONNECTION_STRING)
    return blob_service_client.get_container_client("drawings")

def list_temp_files():
    try:
        container = get_container_client()
        blobs = container.list_blobs(name_starts_with="temp/")
        files = []
        for b in blobs:
            if not b.name.startswith("temp/status/") and not b.name.startswith("temp/json/"):
                 files.append(b.name)
        return files
    except Exception as e:
        print(f"Failed to list blobs: {e}")
        return []

def trigger_debug(filename):
    url = "https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app/api/v1/analyze/debug-sync"
    real_filename = filename # Filename is passed directly
    
    payload = {
        "filename": real_filename,
        "total_pages": 1, # Fast check
        "category": "drawings"
    }
    
    print(f"Triggering Debug Sync for {real_filename}...")
    try:
        res = requests.post(url, json=payload, timeout=300, verify=False) # Disable SSL verify
        print(f"Status Code: {res.status_code}")
        try:
            print(json.dumps(res.json(), indent=2))
        except:
            print(res.text)
    except Exception as e:
        print(f"Request Error: {e}")

if __name__ == "__main__":
    # 1. Find a file
    trigger_debug("119103_CONSOL_GMTP-CS-TS-031-T0.pdf")
