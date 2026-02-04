import asyncio
import os
import requests
import json
from app.services.blob_storage import get_container_client

# Dummy PDF Content (just text, will fail analysis but verify connectivity)
DUMMY_CONTENT = b"%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Kids [3 0 R]\n/Count 1\n> >\nendobj\n3 0 obj\n<<\n/Type /Page\n/MediaBox [0 0 612 792]\n/Resources <<\n/Font <<\n/F1 4 0 R\n>>\n>>\n/Contents 5 0 R\n>>\nendobj\n4 0 obj\n<<\n/Type /Font\n/Subtype /Type1\n/BaseFont /Helvetica\n>>\nendobj\n5 0 obj\n<<\n/Length 44\n>>\nstream\nBT\n/F1 24 Tf\n100 100 Td\n(Hello World) Tj\nET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f\n0000000010 00000 n\n0000000060 00000 n\n0000000111 00000 n\n0000000212 00000 n\n0000000300 00000 n\ntrailer\n<<\n/Size 6\n/Root 1 0 R\n>>\nstartxref\n400\n%%EOF"

FILENAME = "test_debug_zombie.pdf"

async def setup_test_file():
    print(f"Uploading dummy file: {FILENAME}...")
    try:
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(f"temp/{FILENAME}")
        blob_client.upload_blob(DUMMY_CONTENT, overwrite=True)
        print("Upload successful.")
        return True
    except Exception as e:
        print(f"Upload failed: {e}")
        return False

def trigger_debug():
    url = "https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app/api/v1/analyze/debug-sync"
    
    payload = {
        "filename": FILENAME,
        "total_pages": 1,
        "category": "drawings"
    }
    
    print(f"Triggering Debug Sync for {FILENAME}...")
    try:
        res = requests.post(url, json=payload, timeout=300, verify=False)
        print(f"Response Status: {res.status_code}")
        try:
            print(json.dumps(res.json(), indent=2))
        except:
            print(res.text)
    except Exception as e:
        print(f"Request Error: {e}")

if __name__ == "__main__":
    # 1. Upload file
    if asyncio.run(setup_test_file()):
        # 2. Trigger Debug
        trigger_debug()
