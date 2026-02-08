import os
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from dotenv import load_dotenv

load_dotenv()

ENDPOINT = os.getenv("AZURE_SEARCH_ENDPOINT")
KEY = os.getenv("AZURE_SEARCH_KEY")
INDEX_NAME = os.getenv("AZURE_SEARCH_INDEX_NAME", "pdf-search-index")

credential = AzureKeyCredential(KEY)
client = SearchClient(endpoint=ENDPOINT, index_name=INDEX_NAME, credential=credential)

# 1. Check for the file with double extension
filename = "단선도(3차).pdf.pdf"
print(f"Checking for file: {filename}...")

results = client.search(search_text="*", filter=f"source eq '{filename}'", top=5)
count = 0
for result in results:
    count += 1
    print(f"Found document! Cloud Path: {result.get('blob_path')}")
    print(f"Content Preview: {result.get('content')[:100]}...")

if count == 0:
    print(f"❌ File '{filename}' NOT found in index.")

# 2. Check for keyword in that file
keyword = "한전공급"
print(f"\nChecking for keyword '{keyword}' in '{filename}'...")
# Note: Azure Search might require exact match on source or not depending on analyzer, but filter is exact match
results = client.search(search_text=keyword, filter=f"source eq '{filename}'", top=5)
k_count = 0
for result in results:
    k_count += 1
    print(f"✅ Keyword found in chunk {result.get('chunk_id')} (Page {result.get('page')})")
    print(f"Context: {result.get('content')[:200]}...")

if k_count == 0:
    print(f"❌ Keyword '{keyword}' NOT found in '{filename}'.")
