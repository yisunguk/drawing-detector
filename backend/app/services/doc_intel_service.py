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
            features = [DocumentAnalysisFeature.BARCODES, DocumentAnalysisFeature.STYLE_FONT]
            if high_res:
                features.append(DocumentAnalysisFeature.OCR_HIGH_RESOLUTION)
            
            # Create request
            analyze_request = AnalyzeDocumentRequest(url_source=blob_url)
            
            # Start analysis
            poller = self.client.begin_analyze_document(
                model_id="prebuilt-layout",
                body=analyze_request,
                pages=page_range,
                features=features
            )
            
            # ... (rest of function) ...
            
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
        Extract content including Polygons for Spatial Analysis.
        """
        page_num = page.page_number
        
        # 1. Extract text content with Geometry
        lines_data = []
        if hasattr(page, 'lines') and page.lines:
            for line in page.lines:
                lines_data.append({
                    "text": line.content,
                    "polygon": line.polygon,  # List[float] [x1, y1, x2, y2, ...]
                    "confidence": line.confidence if hasattr(line, 'confidence') else 1.0
                })
        
        # Words for finer granularity
        words_data = []
        if hasattr(page, 'words') and page.words:
            for word in page.words:
                words_data.append({
                    "text": word.content,
                    "polygon": word.polygon,
                    "confidence": word.confidence if hasattr(word, 'confidence') else 1.0
                })

        # Barcodes
        barcodes = []
        if hasattr(page, 'barcodes') and page.barcodes:
            for bc in page.barcodes:
                barcodes.append({
                    "kind": bc.kind,
                    "value": bc.value,
                    "polygon": bc.polygon,
                    "confidence": bc.confidence
                })

        content = "\n".join([l["text"] for l in lines_data])
        
        # ... (Tables and KVs extraction - kept similar or simplified) ...
        # For P&ID, tables are less critical than topology, but we keep them.
        
        tables = []
        if hasattr(full_result, 'tables') and full_result.tables:
            for table in full_result.tables:
                 if hasattr(table, 'bounding_regions') and table.bounding_regions:
                    if table.bounding_regions[0].page_number == page_num:
                        tables.append(self._extract_table(table))

        # 4. Build chunk with Geometry
        chunk = {
            "page_number": page_num,
            "content": content,
            "lines": lines_data,   # New: For Spatial Analysis
            "words": words_data,   # New: For Proximity
            "barcodes": barcodes,  # New
            "tables": tables,
            "metadata": {
                "width": page.width,
                "height": page.height,
                "unit": page.unit,
                "angle": page.angle
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
