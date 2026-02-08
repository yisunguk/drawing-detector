import os
from azure.storage.blob import BlobServiceClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

conn_str = os.getenv("AZURE_BLOB_CONNECTION_STRING")
container = os.getenv("AZURE_BLOB_CONTAINER_NAME")

print(f"Container: {container}")

blob_service_client = BlobServiceClient.from_connection_string(conn_str)
container_client = blob_service_client.get_container_client(container)

# Path found in index dump
target_blob = "이성욱/json/제3권 2-2편 기술규격서(청주).pdf.pdf.json" 
# Note: The index said blob_path is "이성욱/json/제3권 2-2편 기술규격서(청주).pdf.pdf"
# Usually chat.py extends it with ".json" or expects it to ALREADY be the json path?
# Let's check typical blob paths.
# Index `blob_path` field usually stores the path to the original PDF or the JSON?
# In `azure_search.py`: `blob_path` argument passed to `index_documents`.
# In `analysis.py`, it seems we index the content.

# Let's list blobs starting with "이성욱/json/"
print("\n--- Listing Blobs in '이성욱/json/' ---")
blobs = container_client.list_blobs(name_starts_with="이성욱/json/")
found = False
for b in blobs:
    if "2-2편" in b.name:
        print(f"Found Blob: {b.name}")
        found = True

if not found:
    print("CRITICAL: JSON blob for Tab 2 NOT FOUND in Blob Storage!")
