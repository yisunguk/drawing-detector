import json
from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential
from app.core.config import settings

class AzureDIService:
    def __init__(self):
        self.endpoint = settings.AZURE_FORM_RECOGNIZER_ENDPOINT
        self.key = settings.AZURE_FORM_RECOGNIZER_KEY
        
        if not self.endpoint or not self.key:
            print("Warning: Azure Document Intelligence credentials not configured.")
            self.client = None
        else:
            self.client = DocumentAnalysisClient(
                endpoint=self.endpoint, 
                credential=AzureKeyCredential(self.key)
            )

    def analyze_document_from_url(self, document_url: str) -> dict:
        if not self.client:
            raise Exception("Azure Document Intelligence client not initialized")

        poller = self.client.begin_analyze_document_from_url("prebuilt-layout", document_url)
        result = poller.result()
        
        return self._format_result(result)

    def _format_result(self, result) -> list:
        output = []
        
        for page in result.pages:
            # Extract content (using the full content of the result for now, 
            # or we could filter by page spans if needed. 
            # The user example shows "page_number" in JSON, implying one object per page or one object overall?)
            # The example is a list `[ { ... } ]`. Let's assume one entry per page.
            
            # Construct layout lines
            lines_data = []
            for line in page.lines:
                lines_data.append({
                    "content": line.content,
                    "polygon": line.polygon  # [x, y, x, y, ...]
                })

            page_data = {
                "content": self._get_page_content(result.content, page.spans),
                "page_number": page.page_number,
                "tables_count": len([t for t in result.tables if any(c.page_number == page.page_number for c in t.cells)]),
                "도면명(TITLE)": "",  # Placeholder as requested
                "도면번호(DWG. NO.)": "REV.", # Placeholder as requested
                "layout": {
                    "width": page.width,
                    "height": page.height,
                    "unit": page.unit,
                    "lines": lines_data
                }
            }
            output.append(page_data)
            
        return output

    def _get_page_content(self, full_content, spans):
        page_text = ""
        for span in spans:
            page_text += full_content[span.offset : span.offset + span.length]
        return page_text

azure_di_service = AzureDIService()
