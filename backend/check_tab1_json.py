#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Check if 단선도(3차).pdf.json exists in blob storage
"""
import os
import sys
from dotenv import load_dotenv
from azure.storage.blob import BlobServiceClient

# Force UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

load_dotenv()

# Azure Blob credentials
connection_string = os.getenv("AZURE_BLOB_CONNECTION_STRING")
container_name = os.getenv("AZURE_BLOB_CONTAINER_NAME")

print(f"Checking container: {container_name}\n")

# Create blob service client
blob_service_client = BlobServiceClient.from_connection_string(connection_string)
container_client = blob_service_client.get_container_client(container_name)

# Check for 단선도 JSON files
search_paths = [
    "이성욱/json/단선도(3차).json",
    "이성욱/json/단선도(3차).pdf.json",
    "이성욱/json/단선도(3차).pdf.pdf.json",
]

print("=" * 80)
print("Checking for 단선도(3차) JSON files:")
print("=" * 80)

for path in search_paths:
    try:
        blob_client = container_client.get_blob_client(path)
        exists = blob_client.exists()
        if exists:
            props = blob_client.get_blob_properties()
            print(f"✅ FOUND: {path}")
            print(f"   Size: {props.size} bytes")
            print(f"   Modified: {props.last_modified}")
            
            # Download and check content
            download = blob_client.download_blob()
            content = download.readall().decode('utf-8')
            import json
            data = json.loads(content)
            
            # Check for "표준소비효율변압기" in content
            content_str = json.dumps(data, ensure_ascii=False)
            if "표준소비효율변압기" in content_str:
                print(f"   ⭐ Contains '표준소비효율변압기': YES")
            else:
                print(f"   ❌ Contains '표준소비효율변압기': NO")
            
            # Show structure
            if 'pages' in data:
                print(f"   Pages: {len(data['pages'])}")
                if data['pages']:
                    first_page = data['pages'][0]
                    if 'lines' in first_page:
                        print(f"   First page lines: {len(first_page['lines'])}")
        else:
            print(f"❌ NOT FOUND: {path}")
    except Exception as e:
        print(f"❌ ERROR checking {path}: {e}")
    print()

# List all files in 이성욱/json/ that contain "단선도"
print("=" * 80)
print("All files in 이성욱/json/ containing '단선도':")
print("=" * 80)

all_blobs = container_client.list_blobs(name_starts_with="이성욱/json/")
matching = [b.name for b in all_blobs if '단선도' in b.name]
print(f"Found {len(matching)} files:")
for b in matching:
    print(f"  - {b}")
