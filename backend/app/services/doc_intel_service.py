"""
Document Intelligence Service
Extracted from working Streamlit implementation.
Handles PDF analysis using Azure Document Intelligence.
"""

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import AnalyzeDocumentRequest, DocumentAnalysisFeature
from azure.core.credentials import AzureKeyCredential
from typing import List, Dict, Any
import os


class DocumentIntelligenceService:
    """Service for analyzing documents using Azure Document Intelligence"""
    
    def __init__(self, endpoint: str = None, key: str = None):
        """
        Initialize Document Intelligence client.
        
        Args:
            endpoint: Azure DI endpoint (defaults to env var)
            key: Azure DI key (defaults to env var)
        """
        from app.core.config import settings
        
        self.endpoint = endpoint or settings.AZURE_DOC_INTEL_ENDPOINT
        self.key = key or settings.AZURE_DOC_INTEL_KEY
        
        if not self.endpoint or not self.key:
            raise ValueError("Azure Document Intelligence endpoint and key are required")
        
        self.client = DocumentIntelligenceClient(
            endpoint=self.endpoint,
            credential=AzureKeyCredential(self.key)
        )
    
    def analyze_document(
        self, 
        blob_url: str, 
        page_range: str = None, 
        high_res: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Analyze document from Blob Storage URL.
        
        Args:
            blob_url: SAS URL to the blob (must include read permissions)
            page_range: Page range to analyze (e.g., "1-10") or None for all pages
            high_res: Whether to use high-resolution OCR (slower but more accurate)
        
        Returns:
            List of page chunks with extracted content
            
        Example:
            chunks = service.analyze_document(
                "https://account.blob.core.windows.net/container/file.pdf?sas_token",
                page_range="1-50"
            )
            
            # chunks = [
            #     {
            #         "page_number": 1,
            #         "content": "Extracted text...",
            #         "tables": [...],
            #         "metadata": {...}
            #     },
            #     ...
            # ]
        """
        try:
            print(f"[DI] Starting analysis: pages={page_range}, high_res={high_res}")
            
            # Prepare features
            features = []
            if high_res:
                features.append(DocumentAnalysisFeature.OCR_HIGH_RESOLUTION)
            
            # Create request
            analyze_request = AnalyzeDocumentRequest(url_source=blob_url)
            
            # Start analysis
            poller = self.client.begin_analyze_document(
                model_id="prebuilt-layout",
                analyze_request=analyze_request,
                pages=page_range,
                features=features if features else None
            )
            
            # Wait for completion
            result = poller.result()
            
            print(f"[DI] Analysis complete: {len(result.pages)} pages processed")
            
            # Extract page chunks
            page_chunks = []
            for page in result.pages:
                chunk = self._extract_page_content(page, result)
                page_chunks.append(chunk)
            
            return page_chunks
            
        except Exception as e:
            print(f"[DI] Analysis failed: {e}")
            raise
    
    def _extract_page_content(self, page: Any, full_result: Any) -> Dict[str, Any]:
        """
        Extract content from a single page.
        
        Args:
            page: Page object from DI result
            full_result: Full analysis result (for accessing paragraphs, tables, etc.)
        
        Returns:
            Dictionary with page content
        """
        page_num = page.page_number
        
        # 1. Extract text content
        # Collect all text from lines (preserves layout better than paragraphs)
        lines = []
        if hasattr(page, 'lines') and page.lines:
            for line in page.lines:
                lines.append(line.content)
        
        # Fallback to words if lines not available
        if not lines and hasattr(page, 'words') and page.words:
            lines = [word.content for word in page.words]
        
        content = "\n".join(lines)
        
        # 2. Extract tables
        tables = []
        if hasattr(full_result, 'tables') and full_result.tables:
            for table in full_result.tables:
                # Check if table belongs to this page
                if hasattr(table, 'bounding_regions') and table.bounding_regions:
                    table_page = table.bounding_regions[0].page_number
                    if table_page == page_num:
                        tables.append(self._extract_table(table))
        
        # 3. Extract key-value pairs (if any)
        key_values = {}
        if hasattr(full_result, 'key_value_pairs') and full_result.key_value_pairs:
            for kv in full_result.key_value_pairs:
                if hasattr(kv, 'key') and kv.key and hasattr(kv.key, 'content'):
                    key_text = kv.key.content
                    value_text = kv.value.content if kv.value and hasattr(kv.value, 'content') else ""
                    
                    # Check if belongs to this page
                    if hasattr(kv.key, 'bounding_regions') and kv.key.bounding_regions:
                        kv_page = kv.key.bounding_regions[0].page_number
                        if kv_page == page_num:
                            key_values[key_text] = value_text
        
        # 4. Build chunk
        chunk = {
            "page_number": page_num,
            "content": content,
            "tables": tables,
            "key_values": key_values,
            "metadata": {
                "width": page.width if hasattr(page, 'width') else None,
                "height": page.height if hasattr(page, 'height') else None,
                "unit": page.unit if hasattr(page, 'unit') else None,
                "angle": page.angle if hasattr(page, 'angle') else 0
            }
        }
        
        return chunk
    
    def _extract_table(self, table: Any) -> Dict[str, Any]:
        """
        Extract table data into structured format.
        
        Args:
            table: Table object from DI result
        
        Returns:
            Dictionary with table data
        """
        rows = []
        
        if hasattr(table, 'cells') and table.cells:
            # Build 2D array
            max_row = max(cell.row_index for cell in table.cells) + 1
            max_col = max(cell.column_index for cell in table.cells) + 1
            
            grid = [['' for _ in range(max_col)] for _ in range(max_row)]
            
            for cell in table.cells:
                grid[cell.row_index][cell.column_index] = cell.content
            
            rows = grid
        
        return {
            "row_count": table.row_count if hasattr(table, 'row_count') else len(rows),
            "column_count": table.column_count if hasattr(table, 'column_count') else (len(rows[0]) if rows else 0),
            "rows": rows
        }


# Singleton instance
_doc_intel_service = None

def get_doc_intel_service() -> DocumentIntelligenceService:
    """Get or create singleton Document Intelligence service"""
    global _doc_intel_service
    if _doc_intel_service is None:
        _doc_intel_service = DocumentIntelligenceService()
    return _doc_intel_service
