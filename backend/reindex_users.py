"""
Re-index existing JSON files from blob storage for specific users.
Uses text-embedding-3-large (3072 dim) for vector search.
"""
import os
import sys
import json
import time

sys.stdout.reconfigure(encoding='utf-8')

# Setup Django-like env
sys.path.insert(0, os.path.dirname(__file__))
from dotenv import load_dotenv
load_dotenv()

from azure.storage.blob import BlobServiceClient
from app.services.azure_search import AzureSearchService
from app.core.config import settings

# Init
conn = os.getenv('AZURE_BLOB_CONNECTION_STRING')
container_name = os.getenv('AZURE_BLOB_CONTAINER_NAME')
blob_client = BlobServiceClient.from_connection_string(conn).get_container_client(container_name)
search_service = AzureSearchService()

TARGET_USERS = ['이근배', '이승준']


def find_pdf_path(user: str, json_filename: str) -> str:
    """Find the actual PDF blob path for a given JSON file."""
    # Derive PDF filename from JSON filename
    pdf_name = json_filename
    if pdf_name.endswith('.json'):
        pdf_name = pdf_name[:-5]  # remove .json
    if not pdf_name.endswith('.pdf'):
        pdf_name = pdf_name + '.pdf'

    # Check common folders
    for folder in ['drawings', 'documents', 'my-documents']:
        candidate = f"{user}/{folder}/{pdf_name}"
        try:
            if blob_client.get_blob_client(candidate).exists():
                return candidate
        except:
            pass

    # Fallback: use documents as default
    return f"{user}/documents/{pdf_name}"


def determine_category(pdf_path: str) -> str:
    """Determine category from PDF path."""
    parts = pdf_path.split('/')
    if len(parts) >= 2:
        folder = parts[1]
        if folder in ['drawings', 'documents', 'my-documents']:
            return folder
    return 'documents'


def reindex_json(user: str, json_blob_name: str):
    """Download JSON from blob and index into Azure Search."""
    filename = json_blob_name.split('/')[-1]
    print(f"\n{'='*60}")
    print(f"[Reindex] {json_blob_name}")

    # Download JSON
    try:
        data = blob_client.get_blob_client(json_blob_name).download_blob().readall()
        pages_data = json.loads(data)
    except Exception as e:
        print(f"  SKIP: Failed to download/parse JSON: {e}")
        return False

    if not pages_data or len(pages_data) == 0:
        print(f"  SKIP: Empty JSON")
        return False

    page_count = len(pages_data)
    print(f"  Pages: {page_count}")

    # Find PDF path
    pdf_path = find_pdf_path(user, filename)
    category = determine_category(pdf_path)

    # Derive source filename (PDF name)
    source_filename = filename
    if source_filename.endswith('.json'):
        source_filename = source_filename[:-5]
    if not source_filename.endswith('.pdf'):
        source_filename = source_filename + '.pdf'

    print(f"  PDF path: {pdf_path}")
    print(f"  Category: {category}")
    print(f"  Source: {source_filename}")

    # Index
    try:
        start = time.time()
        search_service.index_documents(
            filename=source_filename,
            category=category,
            pages_data=pages_data,
            blob_name=pdf_path,
        )
        elapsed = time.time() - start
        print(f"  OK: {page_count} pages indexed in {elapsed:.1f}s")
        return True
    except Exception as e:
        print(f"  ERROR: {e}")
        return False


def main():
    total_success = 0
    total_fail = 0
    total_pages = 0

    for user in TARGET_USERS:
        print(f"\n{'#'*60}")
        print(f"# User: {user}")
        print(f"{'#'*60}")

        json_blobs = list(blob_client.list_blobs(name_starts_with=f'{user}/json/'))
        print(f"JSON files: {len(json_blobs)}")

        for blob in json_blobs:
            success = reindex_json(user, blob.name)
            if success:
                total_success += 1
            else:
                total_fail += 1

    print(f"\n{'='*60}")
    print(f"DONE: {total_success} succeeded, {total_fail} failed")
    print(f"{'='*60}")


if __name__ == '__main__':
    main()
