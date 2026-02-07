
import os
from app.services.blob_storage import get_container_client

def check_blobs():
    container = get_container_client()
    prefix = "json/"
    print(f"Listing blobs with prefix: {prefix}")
    blobs = container.list_blobs(name_starts_with=prefix)
    for blob in blobs:
        print(f"Found Blob: {blob.name} ({blob.size} bytes)")

    print(f"Listing blobs with prefix: 관리자/json/")
    blobs = container.list_blobs(name_starts_with="관리자/json/")
    for blob in blobs:
        print(f"Found Blob: {blob.name} ({blob.size} bytes)")

if __name__ == "__main__":
    check_blobs()
