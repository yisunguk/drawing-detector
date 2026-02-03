import requests
import json
import unicodedata

BASE_URL = "http://localhost:8000/api/v1/azure"

def isolate():
    try:
        # Get path for 이근배/drawings
        resp1 = requests.get(f"{BASE_URL}/list", params={"path": ""})
        items = resp1.json()
        target_subpath = None
        for item in items:
            if "이근배" in item['name']:
                target_subpath = item['path'] + "drawings/"
                break
        
        if not target_subpath:
            with open("target_info.txt", "w", encoding="utf-8") as f:
                f.write("Could not find 이근배 folder")
            return

        resp = requests.get(f"{BASE_URL}/list", params={"path": target_subpath})
        files = resp.json()
        
        found = False
        with open("target_info.txt", "w", encoding="utf-8") as f:
            for file in files:
                name = file['name']
                # Search by date to bypass NFD/NFC issues on the Korean part
                if "2018.10.22" in name:
                    found = True
                    f.write(f"NAME: {name}\n")
                    f.write(f"HEX : {name.encode('utf-8').hex()}\n")
                    f.write(f"LEN : {len(name)}\n")
                    
                    # Check normalization
                    nfc = unicodedata.normalize('NFC', name)
                    nfd = unicodedata.normalize('NFD', name)
                    
                    target_nfc = "부산 프로젝트A_공사동 도면_2018.10.22.pdf"
                    f.write(f"MATCHES TARGET NFC? {name == target_nfc}\n")
                    f.write(f"MATCHES TARGET NFD? {name == unicodedata.normalize('NFD', target_nfc)}\n")
                    
                    f.write("-" * 20 + "\n")
            
            if not found:
                f.write("No file containing '2018.10.22' found.\n")

    except Exception as e:
        with open("target_info.txt", "w", encoding="utf-8") as f:
            f.write(f"Error: {e}")

if __name__ == "__main__":
    isolate()
