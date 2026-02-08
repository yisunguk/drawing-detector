import os
import sys
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from azure.storage.blob import BlobServiceClient
from dotenv import load_dotenv
import json

# Force UTF-8 for console output
sys.stdout.reconfigure(encoding='utf-8')

load_dotenv("backend/.env")

search_endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
search_key = os.getenv("AZURE_SEARCH_KEY")
index_name = "pdf-search-index"
blob_conn_str = os.getenv("AZURE_BLOB_CONNECTION_STRING")
container_name = os.getenv("AZURE_BLOB_CONTAINER_NAME")

search_client = SearchClient(endpoint=search_endpoint, index_name=index_name, credential=AzureKeyCredential(search_key))
blob_service_client = BlobServiceClient.from_connection_string(blob_conn_str)
container_client = blob_service_client.get_container_client(container_name)

query = "제너레이터의 enclosure class에 대해 알려 주세요"
user_filter = "user_id eq '이성욱' or user_id eq 'piere'"

print(f"\n--- Querying: '{query}' with Filter: {user_filter} ---")

try:
    results = search_client.search(
        search_text=query,
        filter=user_filter,
        top=5,
        select=["content", "source", "page", "blob_path"]
    )
    
    found_page_10 = False
    
    for i, r in enumerate(results):
        page = r.get('page')
        source = r.get('source')
        blob_path = r.get('blob_path')
        print(f"\n[{i+1}] Page {page} | {source} | Blob: {blob_path}")
        
        if page == "10" and "2편" in source:
             found_page_10 = True
             print("   *** FOUND TARGET PAGE 10 ***")
             
             # Fetch and Format JSON to check quality
             if blob_path:
                 # Standardize blob path for JSON
                 # If blob_path is PDF, append .json? Or valid path?
                 # From previous checks: 이성욱/json/제3권 2-2편 기술규격서(청주).pdf.pdf
                 # The blob itself is that path? Or that path + .json?
                 # Let's try downloading exactly what's in blob_path first, if fail, append .json
                 
                 blob_name = blob_path
                 if not blob_name.endswith(".json"):
                      # Try appending .json if not present (logic in chat.py varies, let's try direct)
                      # Actually chat.py does: target_blob_path = blob_path (if ends with json) else ...
                      # Let's try to match the known existing blob:
                      # "이성욱/json/제3권 2-2편 기술규격서(청주).pdf.pdf.json"
                      pass

                 # Heuristic: try adding .json
                 json_blob_name = blob_name + ".json"
                 print(f"   Downloading JSON: {json_blob_name}")
                 
                 try:
                     blob_client = container_client.get_blob_client(json_blob_name)
                     if not blob_client.exists():
                         print("   JSON Blob not found with .json extension. Trying exact path...")
                         blob_client = container_client.get_blob_client(blob_name)
                     
                     if blob_client.exists():
                         data = blob_client.download_blob().readall()
                         json_data = json.loads(data)
                         
                         # Find Page 10 data
                         target_page_data = None
                         for p in json_data:
                             if str(p.get('page_number')) == "10":
                                 target_page_data = p
                                 break
                         
                         if target_page_data:
                             # Mimic chat.py formatting logic
                             formatted_context = ""
                             tables = target_page_data.get('tables', [])
                             if tables:
                                formatted_context += f"\n[Structured Tables]\n"
                                for t_idx, table in enumerate(tables):
                                    formatted_context += f"\nTable {t_idx + 1}:\n"
                                    rows = table.get('rows')
                                    # ... (Simplified logic)
                                    if rows:
                                        # Header
                                        header = rows[0]
                                        formatted_context += "| " + " | ".join(header) + " |\n"
                                        for row in rows[1:]:
                                            formatted_context += "| " + " | ".join(row) + " |\n"
                                    formatted_context += "\n"
                             
                             print(f"   --- JSON Context Preview (Tables) ---\n{formatted_context[:1000]}")
                             # Check for 'IP 54'
                             if "IP 54" in formatted_context:
                                 print("   ✅ 'IP 54' Found in Context!")
                             else:
                                 print("   ❌ 'IP 54' NOT Found in Context!")
                                 
                     else:
                         print("   Blob download failed.")
                 except Exception as dl_err:
                     print(f"   Download Error: {dl_err}")

    if not found_page_10:
        print("\n❌ Page 10 was NOT in the Top 5 results.")
        
except Exception as e:
    print(f"Search failed: {e}")
