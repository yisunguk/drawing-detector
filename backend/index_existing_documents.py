"""
Index all existing analyzed documents from Azure Blob Storage into Azure Search.

This script:
1. Lists all JSON files from the blob container
2. Downloads and parses each JSON file
3. Indexes the page content using azure_search_service
"""

import os
import sys
import json
from dotenv import load_dotenv
from azure.storage.blob import ContainerClient

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.azure_search import azure_search_service
from app.core.config import settings

load_dotenv()

def get_container_client():
    """Initialize Azure Blob Container Client"""
    connection_string = settings.AZURE_BLOB_CONNECTION_STRING
    container_name = settings.AZURE_BLOB_CONTAINER_NAME
    return ContainerClient.from_connection_string(connection_string, container_name)

def extract_category_from_path(blob_path: str) -> str:
    """Extract category from blob path"""
    # Example: "drawings/electrical/file.json" -> "electrical"
    parts = blob_path.split('/')
    if len(parts) >= 2:
        return parts[1]
    return "uncategorized"

def main():
    print("=" * 60)
    print("Azure Search Document Indexer")
    print("=" * 60)
    
    # Check if search client is available
    if not azure_search_service.client:
        print("❌ Azure Search client is not configured!")
        print("Please ensure AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_KEY are set in .env")
        return
    
    print(f"✅ Connected to Azure Search: {settings.AZURE_SEARCH_ENDPOINT}")
    print(f"✅ Index: {settings.AZURE_SEARCH_INDEX_NAME}")
    print()
    
    # Connect to blob storage
    container_client = get_container_client()
    print(f"✅ Connected to Blob Storage: {settings.AZURE_BLOB_CONTAINER_NAME}")
    print()
    
    # List all JSON files
    print("📋 Listing JSON files from blob storage...")
    blob_list = container_client.list_blobs()
    
    json_files = []
    for blob in blob_list:
        if blob.name.endswith('.json') and not blob.name.endswith('_metadata.json'):
            json_files.append(blob)
    
    print(f"Found {len(json_files)} JSON files to index")
    print()
    
    # Index each file
    indexed_count = 0
    error_count = 0
    
    for idx, blob in enumerate(json_files, 1):
        blob_name = blob.name
        filename = os.path.basename(blob_name)
        
        print(f"[{idx}/{len(json_files)}] Processing: {blob_name}")
        
        try:
            # Download JSON content
            blob_client = container_client.get_blob_client(blob_name)
            json_content = blob_client.download_blob().readall()
            pages_data = json.loads(json_content)
            
            # Validate it's a list of pages
            if not isinstance(pages_data, list):
                print(f"  ⚠️  Skipping: Not a valid page array")
                error_count += 1
                continue
            
            # Extract category from path
            category = extract_category_from_path(blob_name)
            
            # Index documents
            print(f"  📤 Indexing {len(pages_data)} pages...")
            azure_search_service.index_documents(
                filename=filename.replace('.json', '.pdf'),  # Convert to PDF filename
                category=category,
                pages_data=pages_data,
                blob_name=blob_name.replace('.json', '.pdf')  # Store PDF blob path
            )
            
            print(f"  ✅ Successfully indexed {len(pages_data)} pages")
            indexed_count += 1
            
        except json.JSONDecodeError as e:
            print(f"  ❌ JSON parse error: {e}")
            error_count += 1
        except Exception as e:
            print(f"  ❌ Error: {e}")
            error_count += 1
        
        print()
    
    # Summary
    print("=" * 60)
    print("📊 Indexing Summary")
    print("=" * 60)
    print(f"Total files found: {len(json_files)}")
    print(f"Successfully indexed: {indexed_count}")
    print(f"Errors: {error_count}")
    print()
    
    if indexed_count > 0:
        print("✅ Indexing complete! You can now use 'All Documents' scope in chat.")
    else:
        print("⚠️  No documents were indexed. Please check the errors above.")

if __name__ == "__main__":
    main()
