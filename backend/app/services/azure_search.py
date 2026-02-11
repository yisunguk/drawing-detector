import base64
import json
import logging
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from app.core.config import settings

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

    def index_documents(self, filename: str, category: str, pages_data: list, blob_name: str = None):
        """
        Uploads analyzed pages to Azure AI Search.
        """
        if not self.client:
            logger.warning("Search client is not initialized. Skipping indexing.")
            return

        # Extract user_id from blob_name
        # Example: "관리자/drawings/file.pdf" → user_id = "관리자"
        user_id = "unknown"
        if blob_name:
            parts = blob_name.split('/')
            if len(parts) > 0:
                user_id = parts[0]  # First folder = user name

        documents = []
        for page in pages_data:
            # Create a unique ID for each page
            # MATCH USER LOGIC: base64(blob_path + page_number)
            page_num = page.get("page_number", 0)
            
            if blob_name:
                # User provided logic preference
                doc_id_raw = f"{blob_name}_page_{page_num}"
            else:
                # Fallback
                doc_id_raw = f"{filename}_{page_num}"
                
            doc_id = base64.urlsafe_b64encode(doc_id_raw.encode()).decode().strip("=")

            # Prepare the document for indexing
            # Note: Fields must match your Azure Search Index Schema
            # Common RAG fields: id, content, title, source, page_number
            # 1. Table-to-Markdown for better LLM context
            tables = page.get("tables", [])
            content_text = page.get("content", "")
            if tables:
                table_md = self._format_tables_markdown(tables)
                content_text += f"\n\n[Structured Tables]\n{table_md}"

            # 2. Extract representative coords (normalized 0.0-1.0)
            # We use the bounding box of the first line or first table as a fallback
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
                # Simple normalization (Azure DI units / Layout units)
                # raw_coords [x1, y1, x2, y2, ...]
                for i, val in enumerate(raw_coords):
                    if i % 2 == 0: # X
                        normalized_coords.append(round(val / width, 4))
                    else: # Y
                        normalized_coords.append(round(val / height, 4))
            
            # 3. Classify Type
            content_type = "text"
            if tables:
                content_type = "table"
            elif category == "drawings":
                content_type = "drawing"

            doc = {
                "id": doc_id,
                "user_id": user_id,
                "content": content_text,
                "source": filename,
                "page": str(page_num),
                "title": page.get("도면명(TITLE)", "") or filename,
                "category": category,
                "drawing_no": page.get("도면번호(DWG. NO.)", ""),
                "blob_path": blob_name,
                "metadata_storage_path": f"https://{self.endpoint.split('//')[1].split('.')[0]}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{blob_name}" if blob_name and self.endpoint else "",
                "coords": json.dumps(normalized_coords) if normalized_coords else None,
                "type": content_type
            }
            documents.append(doc)

        if documents:
            # Batch Upload Logic
            BATCH_SIZE = 50
            MAX_PAYLOAD_SIZE = 4 * 1024 * 1024  # 4MB safety limit (Azure limit is usually higher, but safe is better)
            
            current_batch = []
            current_batch_size = 0
            
            import json
            
            total_docs = len(documents)
            print(f"[AzureSearch] Starting batch indexing for {total_docs} documents...")

            for i, doc in enumerate(documents):
                # Optimize Payload: Truncate content_exact (if field exists)
                if "content_exact" in doc and len(doc["content_exact"]) > 1000:
                    doc["content_exact"] = doc["content_exact"][:1000]

                # Estimate size (rough JSON string length)
                doc_size = len(json.dumps(doc))
                
                # Check limits
                if (len(current_batch) >= BATCH_SIZE) or (current_batch_size + doc_size > MAX_PAYLOAD_SIZE):
                    self._upload_batch_with_retry(current_batch)
                    current_batch = []
                    current_batch_size = 0
                
                current_batch.append(doc)
                current_batch_size += doc_size
            
            # Upload remaining
            if current_batch:
                self._upload_batch_with_retry(current_batch)
                
            print(f"[AzureSearch] Completed indexing for {filename}.")
            return True

    def _format_tables_markdown(self, tables: list) -> str:
        """
        Convert DI table objects into a Markdown string.
        """
        import json
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
        import time
        if not batch: return

        for attempt in range(max_retries):
            try:
                result = self.client.upload_documents(documents=batch)
                
                # Check for partial failures
                if not all(r.succeeded for r in result):
                    failed = [r for r in result if not r.succeeded]
                    logger.warning(f"Partial indexing failure: {len(failed)} docs failed in batch.")
                
                print(f"[AzureSearch] Indexed batch of {len(batch)} documents.")
                return
            except Exception as e:
                print(f"[AzureSearch] Batch upload failed (Attempt {attempt+1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    time.sleep(2 ** (attempt + 1))  # Exponential backoff: 2, 4, 8 sec
                else:
                    logger.error(f"Final failure uploading batch: {e}")

azure_search_service = AzureSearchService()
