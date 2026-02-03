import requests
import json

BASE_URL = "http://localhost:8000/api/v1/azure"

def reproduce_korean():
    # 1. Test ASCII File
    ascii_path = "verify_test.json"
    print(f"Attempting download for ASCII path: {ascii_path}")
    try:
        resp = requests.get(f"{BASE_URL}/download", params={"path": ascii_path})
        print(f"ASCII Status Code: {resp.status_code}")
        if resp.status_code == 200 or resp.status_code == 206:
            print("ASCII Download Success!")
        else:
            print(f"ASCII Failed: {resp.text[:200]}")
    except Exception as e:
        print(f"ASCII Request Failed: {e}")

    # 2. List Korean Folder
    korean_folder = "이근배/drawings"
    print(f"\nListing Korean subfolder: {korean_folder}")
    target_file = None
    try:
        resp = requests.get(f"{BASE_URL}/list", params={"path": korean_folder})
        print(f"List Status: {resp.status_code}")
        if resp.status_code == 200:
            items = resp.json()
            print(f"Found {len(items)} items in Korean folder.")
            for item in items:
                print(f"  Item: {item['name']} ({item['type']})")
                if item['type'] == 'file' and not target_file:
                    target_file = item['path']
        else:
             print(f"List Failed: {resp.text}")
    except Exception as e:
        print(f"List Request Failed: {e}")

    # 3. Download Specific Korean Path (User Reported)
    target_file = "이근배/drawings/부산 프로젝트A_공사동 도면_2018.10.22.pdf"
    
    print(f"\nAttempting download for User Path: {target_file}")
    try:
        resp = requests.get(f"{BASE_URL}/download", params={"path": target_file}, stream=True)
        print(f"User Path Status Code: {resp.status_code}")
        if resp.status_code == 200 or resp.status_code == 206:
            print("User Path Download Success! consuming stream...")
            bytes_read = 0
            for chunk in resp.iter_content(chunk_size=8192):
                bytes_read += len(chunk)
                if bytes_read > 100000: # Read 100KB just to verify stream works
                    print("Stream verified (100KB read)")
                    break
        else:
             print(f"User Path Failed: {resp.text[:500]}")
    except Exception as e:
        print(f"User Path Request Failed: {e}")

if __name__ == "__main__":
    reproduce_korean()
