"""
Line List Search Service
- Azure AI Search index management (linelist-index)
- Line-level embedding (text-embedding-3-large, 3072d)
- Batch indexing: 16 texts x 4 parallel workers
- Hybrid search (keyword + vector) with line-level results
- User/PID-scoped filtering
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

INDEX_NAME = "linelist-index"


class LinelistSearchService:
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
                logger.error(f"Failed to initialize Linelist Search Client: {e}")

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
        "id", "line_number", "nb", "fluid_code", "area", "seq_no",
        "pipe_spec", "insulation", "from_equip", "to_equip", "pid_no",
        "operating_temp", "operating_press", "design_temp", "design_press",
        "remarks", "source_page", "content", "content_embedding",
        "username", "source_file", "blob_path",
    }

    def ensure_index(self):
        """Create or recreate the linelist-index if schema is outdated."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")

        try:
            existing = self.index_client.get_index(self.index_name)
            existing_fields = {f.name for f in existing.fields}
            missing = self._REQUIRED_FIELDS - existing_fields
            if missing:
                print(f"[LineList] Index missing fields {missing}, recreating...", flush=True)
                self.recreate_index()
            else:
                print(f"[LineList] Index '{self.index_name}' schema OK", flush=True)
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
            print(f"[LineList] Deleted index '{self.index_name}'", flush=True)
        except Exception:
            pass
        self._create_index()

    def _create_index(self):
        fields = [
            SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
            SearchableField(name="line_number", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="nb", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="fluid_code", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="area", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="seq_no", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="pipe_spec", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="insulation", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="from_equip", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="to_equip", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="pid_no", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="operating_temp", type=SearchFieldDataType.String),
            SimpleField(name="operating_press", type=SearchFieldDataType.String),
            SimpleField(name="design_temp", type=SearchFieldDataType.String),
            SimpleField(name="design_press", type=SearchFieldDataType.String),
            SearchableField(name="remarks", type=SearchFieldDataType.String),
            SimpleField(name="source_page", type=SearchFieldDataType.Int32, filterable=True),
            SearchableField(name="content", type=SearchFieldDataType.String),
            SearchField(
                name="content_embedding",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=3072,
                vector_search_profile_name="default-profile",
            ),
            SimpleField(name="username", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="source_file", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="blob_path", type=SearchFieldDataType.String),
        ]

        vector_search = VectorSearch(
            algorithms=[HnswAlgorithmConfiguration(name="default-algorithm")],
            profiles=[VectorSearchProfile(name="default-profile", algorithm_configuration_name="default-algorithm")],
        )

        index = SearchIndex(name=self.index_name, fields=fields, vector_search=vector_search)
        self.index_client.create_index(index)
        print(f"[LineList] Created index '{self.index_name}'", flush=True)

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

        print(f"[LineList] Generating embeddings: {total} texts in {len(batches)} batches (16x4)", flush=True)

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

    # ── Indexing ──

    def index_lines(self, lines: List[Dict], username: str, source_file: str, blob_path: str) -> int:
        """
        Index line list data into Azure AI Search.
        Returns the number of lines indexed.
        """
        if not self.client or not lines:
            return 0

        self.ensure_index()

        # Phase 1: Build embedding texts
        embed_texts = []
        for line in lines:
            embed_input = (
                f"{line.get('line_number', '')} {line.get('fluid_code', '')} "
                f"{line.get('pipe_spec', '')} From:{line.get('from_equip', '')} "
                f"To:{line.get('to_equip', '')} PID:{line.get('pid_no', '')} "
                f"{line.get('remarks', '')}"
            ).strip() or "empty"
            embed_texts.append(embed_input)

        # Phase 2: Generate embeddings in parallel batches
        embeddings = self._generate_all_embeddings(embed_texts)

        # Phase 3: Build search documents
        search_docs = []
        for i, line in enumerate(lines):
            line_number = line.get("line_number", "")
            raw_id = re.sub(r'[^a-zA-Z0-9_-]', '_', f"{username}_{source_file}_{line_number}")
            safe_id = raw_id.lstrip('_') or f"doc_{raw_id}"

            # Synthesize content for keyword search
            content = (
                f"Line: {line_number}. "
                f"Size: {line.get('nb', '')}. "
                f"Fluid: {line.get('fluid_code', '')}. "
                f"From: {line.get('from_equip', '')}. "
                f"To: {line.get('to_equip', '')}. "
                f"P&ID: {line.get('pid_no', '')}. "
                f"Spec: {line.get('pipe_spec', '')}. "
                f"Insulation: {line.get('insulation', '')}. "
                f"Area: {line.get('area', '')}. "
                f"Remarks: {line.get('remarks', '')}."
            )

            # Parse source_page safely
            source_page = 0
            sp = line.get("source_page", "")
            if sp:
                try:
                    source_page = int(sp)
                except (ValueError, TypeError):
                    pass

            search_docs.append({
                "id": safe_id,
                "line_number": line_number,
                "nb": line.get("nb", ""),
                "fluid_code": line.get("fluid_code", ""),
                "area": line.get("area", ""),
                "seq_no": line.get("seq_no", ""),
                "pipe_spec": line.get("pipe_spec", ""),
                "insulation": line.get("insulation", ""),
                "from_equip": line.get("from_equip", ""),
                "to_equip": line.get("to_equip", ""),
                "pid_no": line.get("pid_no", ""),
                "operating_temp": line.get("operating_temp", ""),
                "operating_press": line.get("operating_press", ""),
                "design_temp": line.get("design_temp", ""),
                "design_press": line.get("design_press", ""),
                "remarks": line.get("remarks", ""),
                "source_page": source_page,
                "content": content,
                "content_embedding": embeddings[i],
                "username": username,
                "source_file": source_file,
                "blob_path": blob_path,
            })

        # Phase 4: Upload in batches
        total_success = 0
        for i in range(0, len(search_docs), self.INDEX_UPLOAD_BATCH_SIZE):
            batch = search_docs[i:i + self.INDEX_UPLOAD_BATCH_SIZE]
            try:
                result = self.client.upload_documents(documents=batch)
                success = sum(1 for r in result if r.succeeded)
                total_success += success
                print(f"[LineList] Uploaded batch {i // self.INDEX_UPLOAD_BATCH_SIZE + 1}: {success}/{len(batch)}", flush=True)
            except Exception as e:
                logger.error(f"Upload batch failed: {e}")

        print(f"[LineList] Total indexed: {total_success}/{len(search_docs)}", flush=True)
        return total_success

    # ── Search ──

    def hybrid_search(self, query: str, username: Optional[str] = None,
                      pid_no: Optional[str] = None, top: int = 20,
                      exact_match: bool = False) -> List[Dict]:
        """
        Hybrid search: keyword + vector with line-level results.
        When exact_match=True, skip vector queries (keyword-only search).
        """
        if not self.client:
            return []

        filters = []
        if username:
            filters.append(f"username eq '{username.replace(chr(39), chr(39)*2)}'")
        if pid_no:
            filters.append(f"pid_no eq '{pid_no.replace(chr(39), chr(39)*2)}'")

        filter_str = " and ".join(filters) if filters else None

        vector_queries = []
        if not exact_match:
            query_vector = self._generate_embedding(query)
            vector_queries = [VectorizedQuery(
                vector=query_vector,
                k_nearest_neighbors=top,
                fields="content_embedding"
            )]

        try:
            results = self.client.search(
                search_text=query,
                vector_queries=vector_queries if vector_queries else None,
                filter=filter_str,
                top=top,
                select="line_number,nb,fluid_code,area,seq_no,pipe_spec,insulation,from_equip,to_equip,pid_no,operating_temp,operating_press,design_temp,design_press,remarks,source_page,content,username,source_file,blob_path",
                highlight_fields="content,line_number,from_equip,to_equip",
                highlight_pre_tag="<mark>",
                highlight_post_tag="</mark>",
            )

            final_list = []
            for r in results:
                azure_highlights = (r.get("@search.highlights") or {}).get("content", [])
                final_list.append({
                    "line_number": r.get("line_number", ""),
                    "nb": r.get("nb", ""),
                    "fluid_code": r.get("fluid_code", ""),
                    "area": r.get("area", ""),
                    "seq_no": r.get("seq_no", ""),
                    "pipe_spec": r.get("pipe_spec", ""),
                    "insulation": r.get("insulation", ""),
                    "from_equip": r.get("from_equip", ""),
                    "to_equip": r.get("to_equip", ""),
                    "pid_no": r.get("pid_no", ""),
                    "operating_temp": r.get("operating_temp", ""),
                    "operating_press": r.get("operating_press", ""),
                    "design_temp": r.get("design_temp", ""),
                    "design_press": r.get("design_press", ""),
                    "remarks": r.get("remarks", ""),
                    "source_page": r.get("source_page", 0),
                    "content": r.get("content", ""),
                    "content_preview": (r.get("content") or "")[:500],
                    "source_file": r.get("source_file", ""),
                    "blob_path": r.get("blob_path", ""),
                    "score": r.get("@search.score", 0),
                    "azure_highlights": azure_highlights,
                })
            return final_list

        except Exception as e:
            logger.error(f"Linelist search failed: {e}")
            return []

    # ── Delete ──

    def delete_by_source_file(self, source_file: str, username: str) -> int:
        """Delete all indexed lines from a specific source file."""
        if not self.client:
            return 0

        safe_user = username.replace("'", "''")
        safe_file = source_file.replace("'", "''")

        try:
            results = self.client.search(
                search_text="*",
                filter=f"username eq '{safe_user}' and source_file eq '{safe_file}'",
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

            print(f"[LineList] Deleted {total_deleted} lines from '{source_file}'", flush=True)
            return total_deleted

        except Exception as e:
            logger.error(f"Delete by source file failed: {e}")
            return 0

    # ── Facets / Index Status ──

    def get_indexed_facets(self, username: str) -> dict:
        """Returns {source_file: indexed_line_count} for a given user."""
        if not self.client:
            return {}
        try:
            safe_user = username.replace("'", "''")
            results = self.client.search(
                search_text="*",
                filter=f"username eq '{safe_user}'",
                facets=["source_file,count:1000"],
                top=0
            )
            facets = results.get_facets()
            if not facets or "source_file" not in facets:
                return {}
            return {f["value"]: f["count"] for f in facets["source_file"]}
        except Exception as e:
            logger.error(f"Failed to get linelist indexed facets for {username}: {e}")
            return {}


# Global singleton
linelist_search_service = LinelistSearchService()
