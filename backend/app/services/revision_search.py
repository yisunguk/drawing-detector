"""
Revision Master Search Service (v2 — Page-level indexing)

- Azure AI Search index management (revision-master-index)
- Page-level chunked embedding (text-embedding-3-large, 3072d)
- Batch indexing: 16 texts × 4 parallel workers
- Hybrid search (keyword + vector) with page-level results
- Project-scoped filtering
"""

import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Optional

from openai import AzureOpenAI
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
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
from azure.search.documents.models import VectorizedQuery

from app.core.config import settings

logger = logging.getLogger(__name__)

INDEX_NAME = "revision-master-index"


class RevisionSearchService:
    def __init__(self):
        self.endpoint = settings.AZURE_SEARCH_ENDPOINT
        self.key = settings.AZURE_SEARCH_KEY
        self.index_name = INDEX_NAME

        self.client = None
        self.index_client = None
        if self.endpoint and self.key:
            try:
                credential = AzureKeyCredential(self.key)
                self.client = SearchClient(
                    endpoint=self.endpoint,
                    index_name=self.index_name,
                    credential=credential
                )
                self.index_client = SearchIndexClient(
                    endpoint=self.endpoint,
                    credential=credential
                )
            except Exception as e:
                logger.error(f"Failed to initialize Revision Search Client: {e}")

        # Embedding client
        self.embedding_client = None
        if settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_KEY:
            try:
                self.embedding_client = AzureOpenAI(
                    azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                    api_key=settings.AZURE_OPENAI_KEY,
                    api_version=settings.AZURE_OPENAI_API_VERSION,
                )
            except Exception as e:
                logger.error(f"Failed to initialize embedding client: {e}")

    _ZERO_VECTOR = [0.0] * 3072
    EMBEDDING_BATCH_SIZE = 16
    EMBEDDING_PARALLEL_BATCHES = 4
    INDEX_UPLOAD_BATCH_SIZE = 50

    # ── Index Management ──

    _REQUIRED_FIELDS = {
        "id", "project_id", "doc_id", "doc_no", "tag_no", "title",
        "phase", "phase_name", "revision", "engineer_name", "revision_date",
        "project_name", "username", "change_description", "content",
        "content_embedding", "blob_path", "page_number", "total_pages",
    }

    def ensure_index(self):
        """Create or recreate the revision-master-index if schema is outdated."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")

        try:
            existing = self.index_client.get_index(self.index_name)
            existing_fields = {f.name for f in existing.fields}
            missing = self._REQUIRED_FIELDS - existing_fields
            if missing:
                print(f"[Revision] Index missing fields {missing}, recreating...", flush=True)
                self.recreate_index()
            else:
                print(f"[Revision] Index '{self.index_name}' schema OK", flush=True)
            return
        except Exception:
            pass

        self._create_index()

    def recreate_index(self):
        """Delete and recreate the index."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")
        try:
            self.index_client.delete_index(self.index_name)
            print(f"[Revision] Deleted index '{self.index_name}'", flush=True)
        except Exception:
            pass
        self._create_index()

    def _create_index(self):
        fields = [
            SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
            SimpleField(name="project_id", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="doc_id", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="doc_no", type=SearchFieldDataType.String, filterable=True, sortable=True),
            SearchableField(name="tag_no", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="title", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="phase", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="phase_name", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="revision", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="engineer_name", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="revision_date", type=SearchFieldDataType.String, filterable=True, sortable=True),
            SimpleField(name="project_name", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="username", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="change_description", type=SearchFieldDataType.String),
            SearchableField(name="content", type=SearchFieldDataType.String),
            SimpleField(name="blob_path", type=SearchFieldDataType.String),
            SimpleField(name="page_number", type=SearchFieldDataType.Int32, filterable=True, sortable=True),
            SimpleField(name="total_pages", type=SearchFieldDataType.Int32, filterable=True),
            SearchField(
                name="content_embedding",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=3072,
                vector_search_profile_name="default-profile",
            ),
        ]

        vector_search = VectorSearch(
            algorithms=[HnswAlgorithmConfiguration(name="default-algorithm")],
            profiles=[VectorSearchProfile(name="default-profile", algorithm_configuration_name="default-algorithm")],
        )

        index = SearchIndex(name=self.index_name, fields=fields, vector_search=vector_search)
        self.index_client.create_index(index)
        print(f"[Revision] Created index '{self.index_name}' (page-level)", flush=True)

    # ── Embedding ──

    def _generate_embedding(self, text: str) -> list:
        if not self.embedding_client:
            return self._ZERO_VECTOR
        try:
            truncated = text[:5500] if len(text) > 5500 else text
            response = self.embedding_client.embeddings.create(
                input=truncated,
                model=settings.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
            )
            return response.data[0].embedding
        except Exception as e:
            logger.warning(f"Embedding failed: {e}")
            return self._ZERO_VECTOR

    def _generate_embeddings_batch(self, texts: list) -> list:
        if not self.embedding_client or not texts:
            return [self._ZERO_VECTOR] * len(texts)
        try:
            truncated = [t[:5500] if len(t) > 5500 else t for t in texts]
            response = self.embedding_client.embeddings.create(
                input=truncated,
                model=settings.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
            )
            results = [self._ZERO_VECTOR] * len(texts)
            for item in response.data:
                results[item.index] = item.embedding
            return results
        except Exception as e:
            logger.warning(f"Batch embedding failed ({len(texts)} texts): {e}")
            return [self._ZERO_VECTOR] * len(texts)

    def _generate_all_embeddings(self, texts: list) -> list:
        if not self.embedding_client or not texts:
            return [self._ZERO_VECTOR] * len(texts)

        total = len(texts)
        results = [self._ZERO_VECTOR] * total

        batches = []
        for i in range(0, total, self.EMBEDDING_BATCH_SIZE):
            batch_texts = texts[i:i + self.EMBEDDING_BATCH_SIZE]
            batches.append((i, batch_texts))

        print(f"[Revision] Generating embeddings: {total} texts in {len(batches)} batches (16×4)", flush=True)

        with ThreadPoolExecutor(max_workers=self.EMBEDDING_PARALLEL_BATCHES) as executor:
            futures = {}
            for start_idx, batch_texts in batches:
                future = executor.submit(self._generate_embeddings_batch, batch_texts)
                futures[future] = start_idx

            for future in as_completed(futures):
                start_idx = futures[future]
                try:
                    batch_results = future.result()
                    for j, emb in enumerate(batch_results):
                        results[start_idx + j] = emb
                except Exception as e:
                    logger.warning(f"Embedding batch at {start_idx} failed: {e}")

        return results

    # ── Page-level Indexing ──

    def index_revision_pages(self, pages: List[Dict], metadata: Dict) -> int:
        """Index multiple pages from a revision document.

        Args:
            pages: List of {"page_number": int, "content": str}
            metadata: Shared metadata for all pages (project_id, doc_id, doc_no, etc.)

        Returns:
            Number of successfully indexed pages.
        """
        if not self.client or not pages:
            return 0

        self.ensure_index()

        total_pages = len(pages)
        project_id = metadata.get("project_id", "")
        doc_id = metadata.get("doc_id", "")
        revision = metadata.get("revision", "")

        # Step 1: Prepare embedding texts for all pages
        embed_texts = []
        for p in pages:
            page_text = p.get("content", "") or ""
            embed_input = f"{metadata.get('doc_no', '')} {metadata.get('title', '')} {page_text}".strip() or "empty"
            embed_texts.append(embed_input)

        # Step 2: Generate embeddings in parallel batches
        embeddings = self._generate_all_embeddings(embed_texts)

        # Step 3: Build search documents
        search_docs = []
        for i, p in enumerate(pages):
            page_num = p.get("page_number", i + 1)
            safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_',
                             f"{project_id}_{doc_id}_{revision}_p{page_num}")

            search_docs.append({
                "id": safe_id,
                "project_id": project_id,
                "doc_id": doc_id,
                "doc_no": metadata.get("doc_no", ""),
                "tag_no": metadata.get("tag_no", ""),
                "title": metadata.get("title", ""),
                "phase": metadata.get("phase", ""),
                "phase_name": metadata.get("phase_name", ""),
                "revision": revision,
                "engineer_name": metadata.get("engineer_name", ""),
                "revision_date": metadata.get("revision_date", ""),
                "project_name": metadata.get("project_name", ""),
                "username": metadata.get("username", ""),
                "change_description": metadata.get("change_description", ""),
                "content": (p.get("content", "") or "")[:30000],
                "content_embedding": embeddings[i],
                "blob_path": metadata.get("blob_path", ""),
                "page_number": page_num,
                "total_pages": total_pages,
            })

        # Step 4: Upload in batches (parallel)
        total_success = 0

        def _upload_batch(batch):
            try:
                result = self.client.upload_documents(documents=batch)
                return sum(1 for r in result if r.succeeded)
            except Exception as e:
                logger.error(f"Index upload batch failed: {e}")
                return 0

        upload_batches = [search_docs[i:i + self.INDEX_UPLOAD_BATCH_SIZE]
                          for i in range(0, len(search_docs), self.INDEX_UPLOAD_BATCH_SIZE)]

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(_upload_batch, batch): batch for batch in upload_batches}
            for future in as_completed(futures):
                total_success += future.result()

        print(f"[Revision] Indexed {total_success}/{total_pages} pages for {metadata.get('doc_no', '')} {revision}", flush=True)
        return total_success

    # ── Legacy single-document indexing (for backward compatibility) ──

    def index_revision_document(self, project_id: str, project_name: str,
                                 doc_id: str, doc_no: str, tag_no: str,
                                 title: str, phase: str, phase_name: str,
                                 revision: str, engineer_name: str,
                                 revision_date: str, change_description: str,
                                 content: str, blob_path: str,
                                 username: str) -> bool:
        """Index a single revision document (legacy — wraps page-level indexing)."""
        pages = [{"page_number": 1, "content": content}]
        metadata = {
            "project_id": project_id, "project_name": project_name,
            "doc_id": doc_id, "doc_no": doc_no, "tag_no": tag_no,
            "title": title, "phase": phase, "phase_name": phase_name,
            "revision": revision, "engineer_name": engineer_name,
            "revision_date": revision_date, "change_description": change_description,
            "blob_path": blob_path, "username": username,
        }
        return self.index_revision_pages(pages, metadata) > 0

    def delete_by_project(self, project_id: str) -> int:
        """Delete all indexed documents for a project."""
        if not self.client:
            return 0

        try:
            results = self.client.search(
                search_text="*",
                filter=f"project_id eq '{project_id.replace(chr(39), chr(39)*2)}'",
                select="id",
                top=5000,
            )

            ids_to_delete = [{"id": r["id"]} for r in results]
            if not ids_to_delete:
                return 0

            # Delete in batches
            total_deleted = 0
            for i in range(0, len(ids_to_delete), 1000):
                batch = ids_to_delete[i:i + 1000]
                result = self.client.delete_documents(documents=batch)
                total_deleted += sum(1 for r in result if r.succeeded)

            print(f"[Revision] Deleted {total_deleted} page-docs from project '{project_id}'", flush=True)
            return total_deleted

        except Exception as e:
            logger.error(f"Delete by project failed: {e}")
            return 0

    def delete_by_revision(self, project_id: str, doc_id: str, revision: str) -> int:
        """Delete all page-docs for a specific revision."""
        if not self.client:
            return 0
        try:
            safe_prefix = re.sub(r'[^a-zA-Z0-9_-]', '_', f"{project_id}_{doc_id}_{revision}")
            results = self.client.search(
                search_text="*",
                filter=f"project_id eq '{project_id.replace(chr(39), chr(39)*2)}' and doc_id eq '{doc_id.replace(chr(39), chr(39)*2)}' and revision eq '{revision.replace(chr(39), chr(39)*2)}'",
                select="id",
                top=5000,
            )
            ids = [{"id": r["id"]} for r in results]
            if not ids:
                return 0
            result = self.client.delete_documents(documents=ids)
            deleted = sum(1 for r in result if r.succeeded)
            print(f"[Revision] Deleted {deleted} page-docs for revision {revision}", flush=True)
            return deleted
        except Exception as e:
            logger.error(f"Delete by revision failed: {e}")
            return 0

    # ── Facets / Index Status ──

    def get_indexed_facets(self, username: str) -> dict:
        """Returns {filename: indexed_page_count} for a given user.

        Extracts the filename from blob_path and counts pages per file.
        """
        if not self.client:
            return {}
        try:
            safe_user = username.replace("'", "''")
            results = self.client.search(
                search_text="*",
                filter=f"username eq '{safe_user}'",
                select=["blob_path"],
                top=5000
            )
            counts = {}
            for r in results:
                blob_path = r.get("blob_path", "")
                if blob_path:
                    filename = blob_path.split("/")[-1]
                    counts[filename] = counts.get(filename, 0) + 1
            return counts
        except Exception as e:
            logger.error(f"Failed to get revision indexed facets for {username}: {e}")
            return {}

    # ── Search ──

    def hybrid_search(self, query: str, project_id: Optional[str] = None,
                      phase: Optional[str] = None, username: Optional[str] = None,
                      top: int = 20) -> List[Dict]:
        """Hybrid search: keyword + vector with page-level results."""
        if not self.client:
            return []

        filters = []
        if project_id:
            filters.append(f"project_id eq '{project_id.replace(chr(39), chr(39)*2)}'")
        if phase:
            filters.append(f"phase eq '{phase.replace(chr(39), chr(39)*2)}'")
        if username:
            filters.append(f"username eq '{username.replace(chr(39), chr(39)*2)}'")

        filter_str = " and ".join(filters) if filters else None

        query_vector = self._generate_embedding(query)

        vector_query = VectorizedQuery(
            vector=query_vector,
            k_nearest_neighbors=top,
            fields="content_embedding"
        )

        try:
            results = self.client.search(
                search_text=query,
                vector_queries=[vector_query],
                filter=filter_str,
                top=top,
                select="project_id,doc_id,doc_no,tag_no,title,phase,phase_name,revision,engineer_name,revision_date,project_name,username,change_description,content,blob_path,page_number,total_pages",
                highlight_fields="content,title,change_description",
                highlight_pre_tag="<mark>",
                highlight_post_tag="</mark>",
            )

            final_list = []
            for r in results:
                azure_highlights = (r.get("@search.highlights") or {}).get("content", [])
                final_list.append({
                    "project_id": r.get("project_id", ""),
                    "doc_id": r.get("doc_id", ""),
                    "doc_no": r.get("doc_no", ""),
                    "tag_no": r.get("tag_no", ""),
                    "title": r.get("title", ""),
                    "phase": r.get("phase", ""),
                    "phase_name": r.get("phase_name", ""),
                    "revision": r.get("revision", ""),
                    "engineer_name": r.get("engineer_name", ""),
                    "revision_date": r.get("revision_date", ""),
                    "project_name": r.get("project_name", ""),
                    "change_description": r.get("change_description", ""),
                    "content_preview": (r.get("content") or "")[:500],
                    "blob_path": r.get("blob_path", ""),
                    "page_number": r.get("page_number", 0),
                    "total_pages": r.get("total_pages", 0),
                    "score": r.get("@search.score", 0),
                    "azure_highlights": azure_highlights,
                })
            return final_list

        except Exception as e:
            logger.error(f"Revision search failed: {e}")
            return []


# Global singleton
revision_search_service = RevisionSearchService()
