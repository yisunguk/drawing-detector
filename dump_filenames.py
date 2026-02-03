import requests
import json
import sys

# Set encoding to utf-8 for stdout
sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "http://localhost:8000/api/v1/azure"

def dump_files():
    try:
        # Get path for 이근배/drawings
        resp1 = requests.get(f"{BASE_URL}/list", params={"path": ""})
        items = resp1.json()
        target_subpath = None
        for item in items:
            if "이근배" in item['name']:
                target_subpath = item['path'] # Check root of 이근배
                break
        
        if not target_subpath:
            print("Could not find 이근배 folder")
            return

        print(f"Listing: {target_subpath}")
        resp = requests.get(f"{BASE_URL}/list", params={"path": target_subpath})
        files = resp.json()
        
        for f in files:
            name = f['name']
            if "pdf" in name.lower():
                print(f"NAME: {name}")
                print(f"HEX : {name.encode('utf-8').hex()}")
                print(f"LEN : {len(name)}")
                print("-" * 20)

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    dump_files()
