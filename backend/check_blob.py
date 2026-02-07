
import os
from app.services.blob_storage import get_container_client

def check_blobs():
    container = get_container_client()
    prefix = "json/"
    print(f"Listing blobs with prefix: {prefix}")
    blobs = container.list_blobs(name_starts_with=prefix)
    found = False
    for blob in blobs:
        print(f"Found Blob: {blob.name} ({blob.size} bytes)")
        if "2018.10.22" in blob.name:
            found = True
    
    if not found:
        print("Target file not found in json/ folder.")

    # Check temp/status just in case
    print("\nChecking Status files:")
    status_blobs = container.list_blobs(name_starts_with="temp/status/")
    for blob in status_blobs:
         if "2018.10.22" in blob.name:
             print(f"Status Blob: {blob.name}")
             # Download and print content
             content = container.get_blob_client(blob.name).download_blob().readall().decode('utf-8')
             print(f"Status Content: {content}")

if __name__ == "__main__":
    check_blobs()
