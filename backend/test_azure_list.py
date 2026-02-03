import sys
import os
from dotenv import load_dotenv

# Add app to path
sys.path.append(os.path.join(os.path.dirname(__file__)))

# Load .env
load_dotenv()

from app.services.blob_storage import get_container_client

def test_list_files():
    try:
        print("Initializing Container Client...")
        container_client = get_container_client()
        print(f"Container Name: {container_client.container_name}")
        
        print("\nListing Blobs (Root):")
        blobs = container_client.walk_blobs(name_starts_with="", delimiter='/')
        count = 0
        for item in blobs:
            print(f" - {item.name} (is_prefix: {item.name.endswith('/')})")
            count += 1
            if count > 10:
                print("... (stopping after 10 items)")
                break
        
        if count == 0:
            print("\n[RESULT] Container is ENABLED but EMPTY (or no permissions).")
        else:
            print(f"\n[RESULT] Found {count} items.")

    except Exception as e:
        print(f"\n[ERROR] {e}")

if __name__ == "__main__":
    test_list_files()
