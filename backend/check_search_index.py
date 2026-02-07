"""
Check/Delete existing Azure Search Index
"""

import os
from azure.core.credentials import AzureKeyCredential
from azure.search.documents.indexes import SearchIndexClient
from dotenv import load_dotenv

load_dotenv()

ENDPOINT = os.getenv("AZURE_SEARCH_ENDPOINT")
KEY = os.getenv("AZURE_SEARCH_KEY")
INDEX_NAME = os.getenv("AZURE_SEARCH_INDEX_NAME", "pdf-search-index")

credential = AzureKeyCredential(KEY)
index_client = SearchIndexClient(endpoint=ENDPOINT, credential=credential)

print(f"Checking index '{INDEX_NAME}'...\n")

try:
    # Try to get the existing index
    existing_index = index_client.get_index(INDEX_NAME)
    
    print(f"✅ Index '{INDEX_NAME}' exists!")
    print(f"\nCurrent fields:")
    for field in existing_index.fields:
        print(f"  - {field.name}: {field.type} (key={field.key}, searchable={field.searchable})")
    
    # Check semantic configuration
    if existing_index.semantic_search:
        print(f"\n⚠️  Semantic configuration found:")
        print(f"{existing_index.semantic_search}")
    
    # Offer to delete
    print(f"\n" + "="*50)
    response = input(f"Delete index '{INDEX_NAME}' and recreate? (yes/no): ")
    
    if response.lower() in ['yes', 'y']:
        index_client.delete_index(INDEX_NAME)
        print(f"✅ Index '{INDEX_NAME}' deleted successfully!")
        print(f"\nNow run: python create_search_index.py")
    else:
        print("Cancelled.")
        
except Exception as e:
    if "not found" in str(e).lower() or "does not exist" in str(e).lower():
        print(f"❌ Index '{INDEX_NAME}' does not exist.")
        print(f"\nRun: python create_search_index.py")
    else:
        print(f"❌ Error: {e}")
