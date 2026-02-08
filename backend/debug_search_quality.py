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

query = "기계분야"
user_filter = "user_id eq '이성욱' or user_id eq 'piere'"

print(f"\n--- Querying: '{query}' with Filter: {user_filter} ---")

try:
    results = search_client.search(
        search_text=query,
        filter=user_filter,
        top=20,
        select=["content", "source", "page", "blob_path", "user_id"]
    )
    
    print(f"\n--- Top 20 Search Results for '{query}' ---")
    
    found_page_4 = False
    
    for i, r in enumerate(results):
        page = r.get('page')
        source = r.get('source')
        user_id = r.get('user_id')
        print(f"[{i+1}] Page {page} | User: {user_id} | {source}")
        if str(page) == "4":
            found_page_4 = True

    if found_page_4:
        print("\n✅ Page 4 IS in the search results.")
    else:
        print("\n❌ Page 4 is NOT in the search results.")
        
except Exception as e:
    print(f"Search failed: {e}")

