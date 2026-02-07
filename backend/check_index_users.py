from app.services.azure_search import azure_search_service

# Search for any documents that might be gulflng's
results = list(azure_search_service.client.search(
    '*', 
    top=100,
    select=['user_id', 'source', 'blob_path']
))

print(f"\n✅ Total documents in index: {len(results)}\n")

# Group by user_id
user_docs = {}
for r in results:
    user_id = r.get('user_id', 'N/A')
    if user_id not in user_docs:
        user_docs[user_id] = []
    user_docs[user_id].append(r)

print("=" * 80)
print(f"{'User ID':<20} {'Document Count':<20}")
print("=" * 80)

for user_id, docs in sorted(user_docs.items()):
    print(f"{user_id:<20} {len(docs):<20}")

print("=" * 80)
print()

# Show blob_path samples
print("Sample blob paths:")
for r in results[:10]:
    blob_path = r.get('blob_path', 'N/A')
    user_id = r.get('user_id', 'N/A')
    source = r.get('source', 'N/A')[:50]
    print(f"  user_id={user_id:<15} blob_path={blob_path}")
