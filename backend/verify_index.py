from app.services.azure_search import azure_search_service

# Get first 10 documents to verify indexing
results = list(azure_search_service.client.search(
    '*', 
    top=10, 
    select=['user_id', 'source', 'page', 'title']
))

print(f"\n✅ Total documents retrieved: {len(results)}\n")
print("=" * 80)
print(f"{'User ID':<15} {'Source':<40} {'Page':<5}")
print("=" * 80)

for r in results:
    user_id = r.get('user_id', 'N/A')[:15]
    source = r.get('source', 'N/A')[:38]
    page = r.get('page', 'N/A')
    print(f"{user_id:<15} {source:<40} {page:<5}")

print("=" * 80)
