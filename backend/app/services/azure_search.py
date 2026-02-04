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

    def index_documents(self, filename: str, category: str, pages_data: list):
        """
        Uploads analyzed pages to Azure AI Search.
        """
        if not self.client:
            logger.warning("Search client is not initialized. Skipping indexing.")
            return

        documents = []
        for page in pages_data:
            # Create a unique ID for each page
            # Base64 encode filename + page to ensure safe ID
            page_num = page.get("page_number", 0)
            doc_id_raw = f"{filename}_{page_num}"
            doc_id = base64.urlsafe_b64encode(doc_id_raw.encode()).decode().strip("=")

            # Prepare the document for indexing
            # Note: Fields must match your Azure Search Index Schema
            # Common RAG fields: id, content, title, source, page_number
            doc = {
                "id": doc_id,
                "content": page.get("content", ""),
                "source": filename,
                "page": str(page_num),
                "title": page.get("도면명(TITLE)", "") or filename,
                "category": category,
                "drawing_no": page.get("도면번호(DWG. NO.)", "")
            }
            documents.append(doc)

        if documents:
            try:
                result = self.client.upload_documents(documents=documents)
                print(f"Indexed {len(documents)} pages for {filename}. Success: {all(r.succeeded for r in result)}")
                return result
            except Exception as e:
                logger.error(f"Failed to upload documents to index: {e}")
                print(f"Indexing Error: {e}")
                raise e

azure_search_service = AzureSearchService()
