import logging
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from app.core.config import settings
import base64

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
            doc = {
                "id": doc_id,
                "user_id": user_id,  # NEW: For user isolation
                "content": page.get("content", ""),
                "source": filename,
                "page": str(page_num),
                "title": page.get("도면명(TITLE)", "") or filename,
                "category": category,
                "drawing_no": page.get("도면번호(DWG. NO.)", ""),
                "blob_path": blob_name, # Store blob path for reference
                "metadata_storage_path": f"https://{self.endpoint.split('//')[1].split('.')[0]}.blob.core.windows.net/drawings/{blob_name}" if blob_name and self.endpoint else ""
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
                # Optimize Payload: Truncate content_exact
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
                    # In a robust system, we might retry only failed ones, but for now log and move on.
                
                print(f"[AzureSearch] Indexed batch of {len(batch)} documents.")
                return
            except Exception as e:
                print(f"[AzureSearch] Batch upload failed (Attempt {attempt+1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    time.sleep(2 ** (attempt + 1))  # Exponential backoff: 2, 4, 8 sec
                else:
                    logger.error(f"Final failure uploading batch: {e}")
                    # Don't raise, just log. We don't want to kill the whole process for one batch failure.

azure_search_service = AzureSearchService()
