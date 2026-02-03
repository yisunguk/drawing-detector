import requests
import json

BASE_URL = "http://localhost:8000/api/v1/azure"

def list_all():
    print("Listing files in root...")
    try:
        resp = requests.get(f"{BASE_URL}/list", params={"path": ""})
        items = resp.json()
        for item in items:
            print(f"ROOT: {item['name']} ({item['type']}) path={item['path']}")
            
            if item['type'] == 'folder':
                # List subfolder
                subpath = item['path']
                print(f"Listing subfolder: {subpath}")
                resp2 = requests.get(f"{BASE_URL}/list", params={"path": subpath})
                subitems = resp2.json()
                for sub in subitems:
                    print(f"  SUB: {sub['name']} ({sub['type']}) path='{sub['path']}'")
    except Exception as e:
        print(f"List failed: {e}")

if __name__ == "__main__":
    list_all()
