import os
import json
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from dotenv import load_dotenv

load_dotenv()

ENDPOINT = os.getenv("AZURE_SEARCH_ENDPOINT")
KEY = os.getenv("AZURE_SEARCH_KEY")
INDEX_NAME = os.getenv("AZURE_SEARCH_INDEX_NAME", "pdf-search-index")

if not ENDPOINT or not KEY:
    print("Error: Azure Search credentials not found in environment.")
    exit(1)

credential = AzureKeyCredential(KEY)
client = SearchClient(endpoint=ENDPOINT, index_name=INDEX_NAME, credential=credential)

print(f"Checking index '{INDEX_NAME}' for document '기계도면 상세스펙_Fuel Gas High (1).json'...")

# Search for the recently completed doc
results = client.search(
    search_text="*",
    filter="source eq '기계도면 상세스펙_Fuel Gas High (1).json'",
    top=10,
    select=["id", "source", "page", "user_id", "coords", "type"]
)

results_list = list(results)

if not results_list:
    print("No documents found in the index.")
else:
    print(f"Found {len(results_list)} documents. Inspecting the first one:")
    for i, res in enumerate(results_list):
        print(f"\n--- Document {i+1} ---")
        print(f"ID: {res.get('id')}")
        print(f"Source: {res.get('source')}")
        print(f"Page: {res.get('page')}")
        print(f"User ID: {res.get('user_id')}")
        print(f"Type: {res.get('type')}")
        coords = res.get('coords')
        if coords:
            try:
                coords_data = json.loads(coords)
                print(f"Coords: {len(coords_data)} points (sample: {coords_data[:4]})")
            except:
                print(f"Coords (raw): {coords[:50]}...")
        else:
            print("Coords: MISSING")
            
        content = res.get('content', '')
        if "[Structured Tables]" in content:
            print("Table Markdown: PRESENT")
        else:
            print("Table Markdown: ABSENT")
