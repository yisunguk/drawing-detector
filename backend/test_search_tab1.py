#!/usr/bin/env python3
"""
Direct Azure Search query to check if 단선도(3차).pdf contains "한전공급"
"""
import os
from dotenv import load_dotenv
from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential

load_dotenv()

# Azure Search credentials
endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
key = os.getenv("AZURE_SEARCH_KEY")
index_name = os.getenv("AZURE_SEARCH_INDEX_NAME") or "pdf-search-index"

print(f"Using index: {index_name}")

# Create search client
search_client = SearchClient(
    endpoint=endpoint,
    index_name=index_name,
    credential=AzureKeyCredential(key)
)

# Test 1: Search for "한전공급" with user filter
print("=" * 80)
print("Test 1: Search for '한전공급' with user_id filter")
print("=" * 80)

user_filter = "user_id eq '이성욱' or user_id eq 'piere'"
results = search_client.search(
    search_text="한전공급",
    filter=user_filter,
    top=50,
    select=["content", "source", "page", "title", "category", "user_id"]
)

results_list = list(results)
print(f"\nTotal Results: {len(results_list)}\n")

# Print first 30 results in detail
print("Detailed Results:")
for idx, r in enumerate(results_list[:30]):
    print(f"  #{idx+1}: {r['source']} (Page {r['page']})")

# Group by source
from collections import defaultdict
by_source = defaultdict(list)
for r in results_list:
    by_source[r['source']].append(r['page'])

print("\nResults by Source:")
for source, pages in sorted(by_source.items()):
    print(f"  - {source}: {len(pages)} results (pages: {sorted(set(pages))})")

# Test 2: Check if 단선도(3차) exists in index at all
print("\n" + "=" * 80)
print("Test 2: Check if 단선도(3차).pdf.pdf exists in index")
print("=" * 80)

source_filter = "search.ismatch('단선도', 'source')"
results2 = search_client.search(
    search_text="*",
    filter=f"{user_filter} and {source_filter}",
    top=10,
    select=["content", "source", "page", "user_id"]
)

results2_list = list(results2)
print(f"\nTotal Results with '단선도' in filename: {len(results2_list)}\n")
for r in results2_list:
    print(f"  - {r['source']} (Page {r['page']}): {r['content'][:100]}...")

# Test 3: Search within 단선도 specifically
print("\n" + "=" * 80)
print("Test 3: Search '한전공급' ONLY in 단선도(3차)")
print("=" * 80)

results3 = search_client.search(
    search_text="한전공급",
    filter=f"{user_filter} and {source_filter}",
    top=10,
    select=["content", "source", "page"]
)

results3_list = list(results3)
print(f"\nResults: {len(results3_list)}\n")
for r in results3_list:
    print(f"  - Page {r['page']}: {r['content'][:200]}...")
