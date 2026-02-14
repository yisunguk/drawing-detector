import base64
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from openai import AzureOpenAI
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from app.core.config import settings
from app.services.blob_storage import get_container_client

logger = logging.getLogger(__name__)


class AzureSearchService:
    def __init__(self):
        self.endpoint = settings.AZURE_SEARCH_ENDPOINT
        self.key = settings.AZURE_SEARCH_KEY
        self.index_name = settings.AZURE_SEARCH_INDEX_NAME

        self.client = None
        if self.endpoint and self.key:
            try:
                self.client = SearchClient(
                    endpoint=self.endpoint,
                    index_name=self.index_name,
                    credential=AzureKeyCredential(self.key)
                )
            except Exception as e:
                logger.error(f"Failed to initialize Azure Search Client: {e}")
        else:
            logger.warning("Azure Search credentials not found.")

        # Embedding client (reuses the same Azure OpenAI endpoint)
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

    # Zero vector fallback (3072 dimensions for text-embedding-3-large)
    _ZERO_VECTOR = [0.0] * 3072

    # Batch embedding config
    EMBEDDING_BATCH_SIZE = 16      # texts per API call
    EMBEDDING_PARALLEL_BATCHES = 4 # concurrent API calls

    def _generate_embedding(self, text: str) -> list:
        """Generate embedding vector for a single text. Returns zero vector on failure."""
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
            logger.warning(f"Embedding generation failed, using zero vector: {e}")
            return self._ZERO_VECTOR

    def _generate_embeddings_batch(self, texts: list) -> list:
        """Generate embeddings for multiple texts in a single API call."""
        if not self.embedding_client or not texts:
            return [self._ZERO_VECTOR] * len(texts)
        try:
            truncated = [t[:5500] if len(t) > 5500 else t for t in texts]
            response = self.embedding_client.embeddings.create(
                input=truncated,
                model=settings.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
            )
            # Response data is ordered by index
            results = [self._ZERO_VECTOR] * len(texts)
            for item in response.data:
                results[item.index] = item.embedding
            return results
        except Exception as e:
            logger.warning(f"Batch embedding failed ({len(texts)} texts), using zero vectors: {e}")
            return [self._ZERO_VECTOR] * len(texts)

    def _generate_all_embeddings(self, texts: list) -> list:
        """Generate embeddings for all texts using batch API + parallel execution."""
        if not self.embedding_client or not texts:
            return [self._ZERO_VECTOR] * len(texts)

        total = len(texts)
        results = [self._ZERO_VECTOR] * total

        # Split into batches of EMBEDDING_BATCH_SIZE
        batches = []
        for i in range(0, total, self.EMBEDDING_BATCH_SIZE):
            batch_texts = texts[i:i + self.EMBEDDING_BATCH_SIZE]
            batches.append((i, batch_texts))

        print(f"[AzureSearch] Embedding {total} texts in {len(batches)} batches ({self.EMBEDDING_PARALLEL_BATCHES} parallel)...", flush=True)

        # Process batches in parallel
        with ThreadPoolExecutor(max_workers=self.EMBEDDING_PARALLEL_BATCHES) as executor:
            futures = {}
            for start_idx, batch_texts in batches:
                future = executor.submit(self._generate_embeddings_batch, batch_texts)
                futures[future] = start_idx

            completed = 0
            for future in as_completed(futures):
                start_idx = futures[future]
                batch_size = min(self.EMBEDDING_BATCH_SIZE, total - start_idx)
                try:
                    embeddings = future.result()
                    for j, emb in enumerate(embeddings):
                        results[start_idx + j] = emb
                except Exception as e:
                    logger.warning(f"Batch embedding at index {start_idx} failed: {e}")

                completed += batch_size
                if completed % 100 < batch_size or completed == total:
                    print(f"[AzureSearch] Embedded {completed}/{total}...", flush=True)

        return results

    def index_documents(self, filename: str, category: str, pages_data: list, blob_name: str = None):
        """
        Uploads analyzed pages to Azure AI Search.
        """
        if not self.client:
            logger.warning("Search client is not initialized. Skipping indexing.")
            return

        # Extract user_id from blob_name
        user_id = "unknown"
        if blob_name:
            parts = blob_name.split('/')
            if len(parts) > 0:
                user_id = parts[0]

        total_pages = len(pages_data)
        print(f"[AzureSearch] Preparing {total_pages} documents...", flush=True)

        # Phase 1: Prepare content texts and document metadata (no embedding yet)
        content_texts = []
        doc_metas = []

        for page_idx, page in enumerate(pages_data):
            page_num = page.get("page_number", 0)

            if blob_name:
                doc_id_raw = f"{blob_name}_page_{page_num}"
            else:
                doc_id_raw = f"{filename}_{page_num}"
            doc_id = base64.urlsafe_b64encode(doc_id_raw.encode()).decode().strip("=")

            # Table-to-Markdown
            tables = page.get("tables", [])
            content_text = page.get("content", "")
            if tables:
                table_md = self._format_tables_markdown(tables)
                content_text += f"\n\n[Structured Tables]\n{table_md}"

            # Concatenated equipment tags (HS + 9717 → HS9717)
            page_lines = page.get("layout", {}).get("lines", [])
            concat_tags = self._extract_concatenated_tags(page_lines)
            if concat_tags:
                content_text += f"\n[Concatenated Tags] {concat_tags}"

            content_texts.append(content_text)

            # Extract coords
            raw_coords = None
            layout = page.get("layout", {})
            width = layout.get("width") or 1.0
            height = layout.get("height") or 1.0

            lines = layout.get("lines", [])
            if lines:
                raw_coords = lines[0].get("polygon")
            elif tables and tables[0].get("cells"):
                raw_coords = tables[0]["cells"][0].get("polygon")

            normalized_coords = []
            if raw_coords and isinstance(raw_coords, list):
                try:
                    flat_coords = []
                    for item in raw_coords:
                        if isinstance(item, (list, tuple)):
                            flat_coords.extend(item)
                        elif isinstance(item, (int, float)):
                            flat_coords.append(item)
                    for i, val in enumerate(flat_coords):
                        if i % 2 == 0:
                            normalized_coords.append(round(val / width, 4))
                        else:
                            normalized_coords.append(round(val / height, 4))
                except (TypeError, ValueError):
                    normalized_coords = []

            # Classify type
            content_type = "text"
            if tables:
                content_type = "table"
            elif category == "drawings":
                content_type = "drawing"

            doc_metas.append({
                "id": doc_id,
                "user_id": user_id,
                "source": filename,
                "page": str(page_num),
                "title": page.get("도면명(TITLE)", "") or filename,
                "category": category,
                "drawing_no": page.get("도면번호(DWG. NO.)", ""),
                "blob_path": blob_name,
                "metadata_storage_path": f"https://{settings.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{blob_name}" if blob_name and settings.AZURE_STORAGE_ACCOUNT_NAME else "",
                "coords": json.dumps(normalized_coords) if normalized_coords else None,
                "type": content_type,
            })

        # Phase 2: Batch embedding (parallel)
        embeddings = self._generate_all_embeddings(content_texts)

        # Phase 3: Assemble final documents
        documents = []
        for i in range(total_pages):
            doc = doc_metas[i].copy()
            doc["content"] = content_texts[i]
            doc["content_vector"] = embeddings[i]
            documents.append(doc)

        # Phase 4: Parallel batch upload
        if documents:
            self._upload_all_batches(documents)
            print(f"[AzureSearch] Completed indexing for {filename}.", flush=True)
            return True

    def _upload_all_batches(self, documents: list):
        """Split documents into batches and upload in parallel."""
        BATCH_SIZE = 50
        MAX_PAYLOAD_SIZE = 4 * 1024 * 1024
        UPLOAD_WORKERS = 4

        # Build batches
        batches = []
        current_batch = []
        current_batch_size = 0

        for doc in documents:
            if "content_exact" in doc and len(doc["content_exact"]) > 1000:
                doc["content_exact"] = doc["content_exact"][:1000]

            doc_size = len(json.dumps(doc))

            if (len(current_batch) >= BATCH_SIZE) or (current_batch_size + doc_size > MAX_PAYLOAD_SIZE):
                batches.append(current_batch)
                current_batch = []
                current_batch_size = 0

            current_batch.append(doc)
            current_batch_size += doc_size

        if current_batch:
            batches.append(current_batch)

        total_docs = len(documents)
        print(f"[AzureSearch] Uploading {total_docs} docs in {len(batches)} batches ({UPLOAD_WORKERS} parallel)...", flush=True)

        # Upload batches in parallel
        with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as executor:
            futures = {executor.submit(self._upload_batch_with_retry, batch): idx for idx, batch in enumerate(batches)}
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"Batch upload failed: {e}")

    def _extract_concatenated_tags(self, lines_data: list) -> str:
        """Adjacent letter+number OCR lines → combined tags (e.g., HS + 9717 → HS9717)"""
        tags = []
        used = set()
        for i, l1 in enumerate(lines_data):
            if i in used:
                continue
            t1 = l1.get("content", "").strip()
            if not re.match(r'^[A-Z]{1,5}$', t1):
                continue
            p1 = l1.get("polygon", [])
            for j, l2 in enumerate(lines_data):
                if j == i or j in used:
                    continue
                t2 = l2.get("content", "").strip()
                if not re.match(r'^\d{1,5}[A-Z]?$', t2):
                    continue
                p2 = l2.get("polygon", [])
                if len(p1) >= 2 and len(p2) >= 2:
                    dx = abs(p1[0] - p2[0])
                    dy = abs(p1[1] - p2[1])
                    if dx < 0.15 and 0.005 < dy < 0.25:
                        tags.append(f"{t1}{t2}")
                        used.add(i)
                        used.add(j)
                        break
        return " ".join(tags)

    def _format_tables_markdown(self, tables: list) -> str:
        """
        Convert DI table objects into a Markdown string.
        """
        md_output = ""
        for i, table in enumerate(tables):
            md_output += f"\nTable {i+1}:\n"

            row_count = table.get("row_count", 0)
            col_count = table.get("column_count", 0)
            cells = table.get("cells", [])

            if not cells: continue

            # Reconstruct grid
            grid = [["" for _ in range(col_count)] for _ in range(row_count)]
            for cell in cells:
                r, c = cell.get("row_index", 0), cell.get("column_index", 0)
                if r < row_count and c < col_count:
                    grid[r][c] = (cell.get("content") or "").replace("\n", " ").strip()

            # Format as Markdown
            for r_idx, row in enumerate(grid):
                md_output += "| " + " | ".join(row) + " |\n"
                if r_idx == 0:
                    md_output += "| " + " | ".join(["---"] * col_count) + " |\n"
            md_output += "\n"
        return md_output

    def _upload_batch_with_retry(self, batch, max_retries=3):
        """
        Uploads a batch of documents with exponential backoff retry.
        """
        if not batch: return

        for attempt in range(max_retries):
            try:
                result = self.client.upload_documents(documents=batch)

                # Check for partial failures
                if not all(r.succeeded for r in result):
                    failed = [r for r in result if not r.succeeded]
                    logger.warning(f"Partial indexing failure: {len(failed)} docs failed in batch.")

                print(f"[AzureSearch] Indexed batch of {len(batch)} documents.", flush=True)
                return
            except Exception as e:
                print(f"[AzureSearch] Batch upload failed (Attempt {attempt+1}/{max_retries}): {e}", flush=True)
                if attempt < max_retries - 1:
                    time.sleep(2 ** (attempt + 1))
                else:
                    logger.error(f"Final failure uploading batch: {e}")


    def get_indexed_facets(self, username: str) -> dict:
        """
        Returns {filename: indexed_page_count} for a given user
        by querying Azure Search facets on the 'source' field.
        """
        if not self.client:
            logger.warning("Search client not initialized. Cannot get facets.")
            return {}

        try:
            results = self.client.search(
                search_text="*",
                filter=f"blob_path ge '{username}/' and blob_path lt '{username}0'",
                facets=["source,count:1000"],
                top=0
            )
            facets = results.get_facets()
            if not facets or "source" not in facets:
                return {}
            return {f["value"]: f["count"] for f in facets["source"]}
        except Exception as e:
            logger.error(f"Failed to get indexed facets for {username}: {e}")
            return {}

    def cleanup_orphaned_index(self, username: str) -> dict:
        """
        Finds index documents whose blob no longer exists and deletes them.
        Returns {"deleted_count": int, "deleted_files": list[str]}.
        """
        if not self.client:
            logger.warning("Search client not initialized.")
            return {"deleted_count": 0, "deleted_files": []}

        print(f"[AzureSearch] Starting orphaned index cleanup for user: {username}", flush=True)

        # 1. Collect all index documents for this user
        all_docs = []  # list of {"id": ..., "blob_path": ..., "source": ...}
        try:
            results = self.client.search(
                search_text="*",
                filter=f"blob_path ge '{username}/' and blob_path lt '{username}0'",
                select=["id", "blob_path", "source"],
                top=1000,
            )
            for doc in results:
                all_docs.append({
                    "id": doc["id"],
                    "blob_path": doc.get("blob_path", ""),
                    "source": doc.get("source", ""),
                })
            # Handle paging if > 1000 docs (continuation)
            while True:
                try:
                    page = results.get_next()
                    if not page:
                        break
                    for doc in page:
                        all_docs.append({
                            "id": doc["id"],
                            "blob_path": doc.get("blob_path", ""),
                            "source": doc.get("source", ""),
                        })
                except StopIteration:
                    break
        except Exception as e:
            logger.error(f"Failed to query index for cleanup: {e}")
            return {"deleted_count": 0, "deleted_files": []}

        print(f"[AzureSearch] Found {len(all_docs)} index documents for {username}", flush=True)

        if not all_docs:
            return {"deleted_count": 0, "deleted_files": []}

        # 2. Get unique blob_paths and check existence
        unique_paths = set(d["blob_path"] for d in all_docs if d["blob_path"])
        print(f"[AzureSearch] Checking {len(unique_paths)} unique blob paths...", flush=True)

        missing_paths = set()
        try:
            container_client = get_container_client()
            for blob_path in unique_paths:
                try:
                    blob_client = container_client.get_blob_client(blob_path)
                    if not blob_client.exists():
                        missing_paths.add(blob_path)
                except Exception:
                    missing_paths.add(blob_path)
        except Exception as e:
            logger.error(f"Failed to check blob existence: {e}")
            return {"deleted_count": 0, "deleted_files": []}

        if not missing_paths:
            print(f"[AzureSearch] No orphaned index entries found.", flush=True)
            return {"deleted_count": 0, "deleted_files": []}

        # 3. Collect doc IDs to delete and filenames
        docs_to_delete = [d["id"] for d in all_docs if d["blob_path"] in missing_paths]
        deleted_files = sorted(set(
            d["source"] for d in all_docs if d["blob_path"] in missing_paths and d["source"]
        ))

        print(f"[AzureSearch] Found {len(docs_to_delete)} orphaned documents from {len(deleted_files)} files", flush=True)

        # 4. Batch delete (1000 docs per batch)
        BATCH_SIZE = 1000
        total_deleted = 0
        for i in range(0, len(docs_to_delete), BATCH_SIZE):
            batch_ids = docs_to_delete[i:i + BATCH_SIZE]
            batch_docs = [{"id": doc_id} for doc_id in batch_ids]
            try:
                result = self.client.delete_documents(documents=batch_docs)
                succeeded = sum(1 for r in result if r.succeeded)
                total_deleted += succeeded
                print(f"[AzureSearch] Deleted batch {i // BATCH_SIZE + 1}: {succeeded}/{len(batch_ids)}", flush=True)
            except Exception as e:
                logger.error(f"Batch delete failed at offset {i}: {e}")

        print(f"[AzureSearch] Cleanup complete: {total_deleted} documents deleted", flush=True)
        return {"deleted_count": total_deleted, "deleted_files": deleted_files}


azure_search_service = AzureSearchService()
