import requests
from azure.storage.blob import BlobServiceClient
import json

# Configuration from App.jsx
ACCOUNT_NAME = "encdevmkcsaaitest"
CONTAINER_NAME = "blob-leesunguk"
SAS_TOKEN = "sv=2024-11-04&ss=bfqt&srt=sco&sp=rwdlacupiytfx&se=2027-12-31T09:21:21Z&st=2026-01-29T01:06:21Z&spr=https,http&sig=V4Ha%2Bu0hAKwVpQE86WNvD4nBTBgvFe1c6bii3PjCQcE%3D"
BASE_URL = "https://drawing-detector-backend-435353955407.us-central1.run.app"

TEST_FILENAME = "verify_test.json"
TEST_CONTENT = {"status": "ok", "message": "This is a test file to verify MIME types."}

def run_test():
    print("--- Starting Upload & Verify Test ---")

    # 1. Upload File directly to Azure
    print(f"\n1. Uploading {TEST_FILENAME} to Azure...")
    try:
        # Decode the double-encoded comma if present? The provided token looks standard URL encoded.
        # But requests/azure-sdk usually handles it.
        # The token in App.jsx has %2C?? No, it has %3D (=) and %2B (+).
        # We'll use it as is.
        
        account_url = f"https://{ACCOUNT_NAME}.blob.core.windows.net"
        # We need to manually construct the client because SDK might fight with the token string
        blob_service_client = BlobServiceClient(account_url, credential=SAS_TOKEN)
        container_client = blob_service_client.get_container_client(CONTAINER_NAME)
        
        blob_client = container_client.get_blob_client(TEST_FILENAME)
        blob_client.upload_blob(json.dumps(TEST_CONTENT), overwrite=True)
        print("   Upload Success.")
    except Exception as e:
        print(f"   Upload FAILED: {e}")
        return

    # 2. Download via Backend API
    print(f"\n2. Downloading via Backend: {BASE_URL}/api/v1/azure/download?path={TEST_FILENAME}")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/azure/download", params={"path": TEST_FILENAME})
        
        print(f"   Status Code: {r.status_code}")
        print(f"   Content-Type: {r.headers.get('Content-Type')}")

        if r.status_code == 200:
            ct = r.headers.get('Content-Type', '').lower()
            if 'application/json' in ct:
                print("\n✅ SUCCESS: Backend returned application/json.")
            else:
                print(f"\n❌ FAILURE: Backend returned {ct} (Expected application/json).")
                print("   The fix might not be deployed yet.")
        else:
            print(f"   Request failed: {r.text}")

    except Exception as e:
        print(f"   Download FAILED: {e}")

if __name__ == "__main__":
    run_test()
