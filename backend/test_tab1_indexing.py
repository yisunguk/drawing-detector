#!/usr/bin/env python3
"""
Test if "표준소비효율변압기" is indexed in 단선도(3차).pdf
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

print(f"Testing index: {index_name}\n")

# Create search client
search_client = SearchClient(
    endpoint=endpoint,
    index_name=index_name,
    credential=AzureKeyCredential(key)
)

# Test 1: Search for "표준소비효율변압기" everywhere
print("=" * 80)
print("Test 1: Search for '표준소비효율변압기' (all documents)")
print("=" * 80)

user_filter = "user_id eq '이성욱' or user_id eq 'piere'"
results = search_client.search(
    search_text="표준소비효율변압기",
    filter=user_filter,
    top=100,
    select=["content", "source", "page", "user_id"]
)

results_list = list(results)
print(f"\nTotal Results: {len(results_list)}\n")

# Group by source
from collections import defaultdict
by_source = defaultdict(list)
for r in results_list:
    by_source[r['source']].append(r['page'])

print("Results by Source:")
for source, pages in sorted(by_source.items()):
    pages_sorted = sorted(set(pages))
    print(f"  - {source}: {len(pages)} results")
    if '단선도' in source:
        print(f"    ⭐ FOUND IN TAB 1! Pages: {pages_sorted}")
    else:
        print(f"    Pages: {pages_sorted}")

# Test 2: Check what's actually in 단선도(3차) index
print("\n" + "=" * 80)
print("Test 2: All content from 단선도(3차).pdf (first 5 entries)")
print("=" * 80)

source_filter = "search.ismatch('단선도', 'source')"
results2 = search_client.search(
    search_text="*",
    filter=f"{user_filter} and {source_filter}",
    top=5,
    select=["content", "source", "page"]
)

results2_list = list(results2)
print(f"\nSample entries from 단선도(3차): {len(results2_list)}\n")
for idx, r in enumerate(results2_list):
    print(f"{idx+1}. Page {r['page']}: {r['content'][:300]}...")
    print()

# Test 3: Check if "변압기" exists in 단선도
print("=" * 80)
print("Test 3: Search '변압기' in 단선도(3차)")
print("=" * 80)

results3 = search_client.search(
    search_text="변압기",
    filter=f"{user_filter} and {source_filter}",
    top=20,
    select=["content", "source", "page"]
)

results3_list = list(results3)
print(f"\nResults for '변압기' in 단선도: {len(results3_list)}\n")
for idx, r in enumerate(results3_list[:5]):
    print(f"{idx+1}. Page {r['page']}: {r['content'][:200]}...")
