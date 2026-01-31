import requests
import json
import urllib.parse

BASE_URL = "https://drawing-detector-backend-435353955407.us-central1.run.app"

def list_files_recursive(path=""):
    print(f"Listing: {path}")
    try:
        url = f"{BASE_URL}/api/v1/azure/list"
        params = {"path": path}
        r = requests.get(url, params=params)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"Error listing {path}: {e}")
        return []

def test_azure_json_flow():
    print(f"Testing against: {BASE_URL}")

    # 1. List root
    items = list_files_recursive("")
    
    json_file = None
    folders_to_check = [i['path'] for i in items if i['type'] == 'folder']
    
    # Check root first
    for item in items:
        if item.get('type') == 'file' and item['name'].lower().endswith('.json'):
            json_file = item
            break
            
    # Check first level folders if not found
    if not json_file:
        for folder_path in folders_to_check:
            sub_items = list_files_recursive(folder_path)
            for item in sub_items:
                if item.get('type') == 'file' and item['name'].lower().endswith('.json'):
                    json_file = item
                    break
            if json_file:
                break
    
    if not json_file:
        print("   [!] No JSON file found in root or first level folders.")
        return

    print(f"\n   Target JSON file: {json_file['name']} (Path: {json_file['path']})")
    
    # 2. Download the file
    print(f"\n2. Downloading...")
    try:
        download_url = f"{BASE_URL}/api/v1/azure/download"
        params = {"path": json_file['path']}
        
        r = requests.get(download_url, params=params)
        
        print(f"   Status Code: {r.status_code}")
        print(f"   Content-Type: {r.headers.get('Content-Type')}")
        print(f"   Content Length: {len(r.content)} bytes")

        if r.status_code != 200:
            print(f"   FAILED: Download failed with status {r.status_code}")
            print(r.text[:200])
            return

        # 3. Check Content-Type
        ct = r.headers.get('Content-Type', '').lower()
        if 'application/json' in ct:
            print("   PASS: Content-Type is correct (application/json)")
        else:
            print(f"   WARN: Content-Type is '{ct}'. Frontend might treat this as binary/pdf.")

        # 4. Attempt to parse JSON
        try:
            data = r.json()
            print("   PASS: Body is valid JSON.")
        except Exception as e:
            print(f"   FAILED: Could not parse response body as JSON: {e}")

    except Exception as e:
        print(f"   FAILED during download request: {e}")

if __name__ == "__main__":
    test_azure_json_flow()
