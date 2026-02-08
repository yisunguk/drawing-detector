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

print(f"Listing all unique sources in index '{INDEX_NAME}'...")

# Use a facet query to get unique values for the 'source' field
results = client.search(search_text="*", facets=["source,count:100"], top=0)

if results.get_facets() and "source" in results.get_facets():
    sources = results.get_facets()["source"]
    print(f"Found {len(sources)} unique documents:")
    for s in sources:
        print(f" - {s['value']} (Count: {s['count']})")
else:
    print("No facets found for 'source'. Listing top 50 docs...")
    results = client.search(search_text="*", select=["source"], top=50)
    seen = set()
    for r in results:
        src = r.get("source")
        if src and src not in seen:
            print(f" - {src}")
            seen.add(src)
