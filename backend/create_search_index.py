"""
Create Azure Search Index with proper schema for PDF search.

This script creates the 'pdf-search-index' with all required fields
to match what's being indexed in azure_search.py and queried in chat.py.
"""

import os
from azure.core.credentials import AzureKeyCredential
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SimpleField,
    SearchableField,
    SearchField,
    SearchFieldDataType,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
)
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

ENDPOINT = os.getenv("AZURE_SEARCH_ENDPOINT")
KEY = os.getenv("AZURE_SEARCH_KEY")
INDEX_NAME = os.getenv("AZURE_SEARCH_INDEX_NAME", "pdf-search-index")

if not ENDPOINT or not KEY:
    raise ValueError("AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_KEY must be set in .env")

print(f"Creating index '{INDEX_NAME}' at {ENDPOINT}")

# Create index client
credential = AzureKeyCredential(KEY)
index_client = SearchIndexClient(endpoint=ENDPOINT, credential=credential)

# Define the index schema
# Fields must match what's being indexed in azure_search.py (lines 54-64)
fields = [
    SearchField(
        name="id",
        type=SearchFieldDataType.String,
        key=True,
        filterable=True
    ),
    SearchField(
        name="user_id",
        type=SearchFieldDataType.String,
        filterable=True,
        facetable=True
    ),
    SearchField(
        name="content",
        type=SearchFieldDataType.String,
        searchable=True
    ),
    SearchField(
        name="source",
        type=SearchFieldDataType.String,
        searchable=True,
        filterable=True,
        facetable=True
    ),
    SearchField(
        name="page",
        type=SearchFieldDataType.String,
        filterable=True
    ),
    SearchField(
        name="title",
        type=SearchFieldDataType.String,
        searchable=True,
        filterable=True
    ),
    SearchField(
        name="category",
        type=SearchFieldDataType.String,
        filterable=True,
        facetable=True
    ),
    SearchField(
        name="drawing_no",
        type=SearchFieldDataType.String,
        searchable=True,
        filterable=True
    ),
    SearchField(
        name="blob_path",
        type=SearchFieldDataType.String,
        filterable=True
    ),
    SearchField(
        name="metadata_storage_path",
        type=SearchFieldDataType.String,
        filterable=True
    ),
    SearchField(
        name="coords",
        type=SearchFieldDataType.String,
        filterable=True
    ),
    SearchField(
        name="type",
        type=SearchFieldDataType.String,
        filterable=True,
        facetable=True
    ),
    SearchField(
        name="content_vector",
        type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
        searchable=True,
        vector_search_dimensions=3072,
        vector_search_profile_name="my-vector-profile",
    ),
]

# Vector search configuration
vector_search = VectorSearch(
    algorithms=[
        HnswAlgorithmConfiguration(name="my-hnsw-config"),
    ],
    profiles=[
        VectorSearchProfile(
            name="my-vector-profile",
            algorithm_configuration_name="my-hnsw-config",
        ),
    ],
)

# Create the index
index = SearchIndex(name=INDEX_NAME, fields=fields, vector_search=vector_search)

try:
    result = index_client.create_or_update_index(index)
    print(f"[OK] Index '{result.name}' created/updated successfully!")
    print(f"\nIndex schema:")
    for field in result.fields:
        print(f"  - {field.name}: {field.type}")
except Exception as e:
    print(f"[ERROR] Error creating index: {e}")
    raise
