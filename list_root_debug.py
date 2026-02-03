import requests
import json

BASE_URL = "http://localhost:8000/api/v1/azure"

def list_root_debug():
    print("Listing ROOT files with repr()...")
    try:
        resp = requests.get(f"{BASE_URL}/list", params={"path": ""})
        items = resp.json()
        for item in items:
            print(f"ROOT: {repr(item['name'])} path={repr(item['path'])}")
            
            if "이근배" in item['name']:
                # List subfolder 'drawings'
                subpath = item['path'] + "drawings/"
                print(f"Listing specific subfolder: {subpath}")
                try:
                    resp3 = requests.get(f"{BASE_URL}/list", params={"path": subpath})
                    files = resp3.json()
                    
                    target_name = "부산 프로젝트A_공사동 도면_2018.10.22.pdf"
                    print(f"EXPECTED HEX ({target_name}): {target_name.encode('utf-8').hex()}")
                    
                    found_match = False
                    for f in files:
                         if "부산" in f['name']:
                             print(f"FAIL CANDIDATE: {repr(f['name'])}")
                             print(f"ACTUAL HEX    : {f['name'].encode('utf-8').hex()}")
                             
                             if f['name'] == target_name:
                                 print(">>> MATCH FOUND! Strings are identical.")
                                 found_match = True
                             else:
                                 print(">>> MISMATCH! Strings differ.")
                                 
                                 import unicodedata
                                 nfc = unicodedata.normalize('NFC', f['name'])
                                 nfd = unicodedata.normalize('NFD', f['name'])
                                 
                                 if nfc == target_name:
                                     print(">>> MATCHES IF NORMALIZED TO NFC!")
                                 elif nfd == target_name:
                                     print(">>> MATCHES IF NORMALIZED TO NFD!")
                    
                    if not found_match:
                        print(">>> NO EXACT MATCH FOUND.")

                except Exception as e:
                    print(f"    Sub-list failed: {e}")
    except Exception as e:
        print(f"List failed: {e}")

if __name__ == "__main__":
    list_root_debug()
