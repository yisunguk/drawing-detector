import os
import sys
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from dotenv import load_dotenv

# Force UTF-8 for console output
sys.stdout.reconfigure(encoding='utf-8')

load_dotenv("backend/.env")

endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
key = os.getenv("AZURE_SEARCH_KEY")
index_name = "pdf-search-index"

print(f"Endpoint: {endpoint}")
print(f"Index: {index_name}")

client = SearchClient(endpoint=endpoint, index_name=index_name, credential=AzureKeyCredential(key))

# 1. Inspect User IDs with Hex to ensure encoding match
print("\n--- Inspecting User IDs (Hex) ---")
results = client.search(search_text="*", select=["user_id"], top=50)
seen_users = set()

for r in results:
    uid = r.get('user_id')
    if uid and uid not in seen_users:
        seen_users.add(uid)
        hex_val = ":".join("{:02x}".format(ord(c)) for c in uid)
        print(f"User: '{uid}' | Hex: {hex_val}")

# 2. Try Exact Filter for '이성욱'
target_user = "이성욱"
print(f"\n--- Testing Filter: user_id eq '{target_user}' ---")
try:
    results = client.search(search_text="*", filter=f"user_id eq '{target_user}'", top=5)
    count = 0
    for r in results:
        count += 1
        print(f"Found: {r.get('source')}")
    print(f"Total Found: {count}")
except Exception as e:
    print(f"Filter Error: {e}")

# 3. Search for "2편" or "Tab 2" documents (No Filter)
print(f"\n--- Checking for '2편' or 'Tab 2' documents (No Filter) ---")
# Adjust search text to likely filename parts
search_terms = ["2편", "기술규격서"] 

with open("index_dump_utf8.txt", "w", encoding="utf-8") as f:
    for term in search_terms:
        msg = f"\nSearching for term: '{term}'"
        print(msg)
        f.write(msg + "\n")
        
        try:
            results = client.search(search_text=term, top=10, select=["source", "user_id", "blob_path"])
            count = 0
            for r in results:
                count += 1
                line = f"Found: {r.get('source')} | User: {r.get('user_id')} | Blob: {r.get('blob_path')}"
                print(line)
                f.write(line + "\n")
            
            if count == 0:
                print("No documents found.")
                f.write("No documents found.\n")
        except Exception as e:
            print(f"Search Error: {e}")
            f.write(f"Search Error: {e}\n")

