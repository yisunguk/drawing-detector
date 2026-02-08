import os
from azure.storage.blob import BlobServiceClient
from dotenv import load_dotenv

load_dotenv()

CONN_STR = os.getenv("AZURE_BLOB_CONNECTION_STRING")
CONTAINER_NAME = os.getenv("AZURE_BLOB_CONTAINER_NAME", "drawings")

blob_service_client = BlobServiceClient.from_connection_string(CONN_STR)
container_client = blob_service_client.get_container_client(CONTAINER_NAME)

# Paths to test (based on hypothesis)
candidates = [
    "이성욱/json/단선도(3차).pdf.json",
    "이성욱/json/단선도(3차).pdf.pdf.json",
    "이성욱/json/단선도(3차).json",
    "이성욱/json/단선도(3차).pdf"
]

print(f"Checking container: {CONTAINER_NAME}")

for blob_path in candidates:
    print(f"\nChecking: {blob_path}")
    blob_client = container_client.get_blob_client(blob_path)
    
    if blob_client.exists():
        print("✅ Exists!")
        try:
            data = blob_client.download_blob().readall()
            print(f"✅ Downloaded {len(data)} bytes.")
            print(f"Start: {data[:50]}")
        except Exception as e:
            print(f"❌ Download failed: {e}")
    else:
        print("❌ Does not exist.")

print("\nListing blobs starting with '이성욱/json/단선도'...")
blob_list = container_client.list_blobs(name_starts_with="이성욱/json/단선도")
for blob in blob_list:
    print(f" - {blob.name}")
