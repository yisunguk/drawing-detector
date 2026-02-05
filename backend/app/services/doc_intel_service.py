"""
Document Intelligence Service
Extracted from working Streamlit implementation.
Handles PDF analysis using Azure Document Intelligence.
"""

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import AnalyzeDocumentRequest, DocumentAnalysisFeature
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import HttpResponseError
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
            # Create request logic with conditional 'pages'
            kwargs = dict(
                model_id="prebuilt-layout",
                body=analyze_request,
                features=features
            )
            
            if page_range: # Only add if not None/Empty
                kwargs["pages"] = page_range
            
            # Start analysis
            poller = self.client.begin_analyze_document(**kwargs)
            
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
            # [Added by User Request] Detailed Logging for HttpResponseError
            if isinstance(e, HttpResponseError):
                print("[DI] status:", getattr(e, "status_code", None))
                print("[DI] message:", e.message)
                try:
                    if hasattr(e, "response") and hasattr(e.response, "text"):
                         print("[DI] response text:", e.response.text())
                except:
                    pass

            print(f"[DI] Analysis failed: {e}")
            raise

    def create_optimized_pdf_bytes(self, blob_url: str, page_range: str, dpi: int = 150, max_dimension: int = 3000) -> bytes:
        """
        Downloads PDF to temp file, renders requested pages as images (High Quality), and creates a new PDF.
        Returns the bytes of the new PDF.
        """
        import requests
        import fitz # PyMuPDF
        import io
        import tempfile
        import os
        from PIL import Image

        print(f"[HighQualityFallback] Downloading PDF from URL to temp file...")
        
        tmp_path = None
        try:
            # 1. Download original PDF to Temp File (Streamed)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
                tmp_path = tmp_file.name
                with requests.get(blob_url, stream=True) as r:
                    r.raise_for_status()
                    for chunk in r.iter_content(chunk_size=8192):
                        tmp_file.write(chunk)
            
            print(f"[HighQualityFallback] Downloaded to {tmp_path} ({os.path.getsize(tmp_path)/1024/1024:.2f} MB)")

            # Open from disk
            doc = fitz.open(tmp_path)
            new_doc = fitz.open() # output PDF
            
            # 2. Parse Page Range
            # format: "1-5", "1,3,5" or None
            target_pages = []
            if not page_range:
                target_pages = range(len(doc))
            elif "-" in str(page_range):
                start, end = map(int, str(page_range).split('-'))
                target_pages = range(start - 1, end) # 0-indexed
            else:
                # Handle "1" or "1,2"
                parts = str(page_range).split(',')
                for p in parts:
                    target_pages.append(int(p) - 1)
            
            print(f"[HighQualityFallback] Processing {len(target_pages)} pages (High Quality)...")

            # 3. Render and Add
            for i, p_idx in enumerate(target_pages):
                if p_idx < 0 or p_idx >= len(doc): continue
                
                # Log progress every 5 pages
                if i % 5 == 0:
                    print(f"[HighQualityFallback] Optimizing page {p_idx+1} ({i+1}/{len(target_pages)})")

                page = doc.load_page(p_idx)
                
                # Calculate resize scale
                # Default 72 DPI. Target 150 DPI = 2.08x
                # But check dimension limit (3000px)
                rect = page.rect
                scale = dpi / 72.0
                
                if rect.width * scale > max_dimension or rect.height * scale > max_dimension:
                    scale = min(max_dimension / rect.width, max_dimension / rect.height)
                    
                mat = fitz.Matrix(scale, scale)
                pix = page.get_pixmap(matrix=mat)
                
                # Convert to PIL for easy JPEG compression (strip alpha to save space)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                
                # [High Accuracy] Keep RGB, Quality 85
                
                # Save to JPEG bytes
                img_bio = io.BytesIO()
                img.save(img_bio, format="JPEG", quality=85, optimize=True)
                img_bytes = img_bio.getvalue()
                
                # Create new PDF page from image
                img_page = new_doc.new_page(width=pix.width, height=pix.height)
                img_page.insert_image(img_page.rect, stream=img_bytes)
                
            # 4. Save
            print(f"[Fallback] Rebuilding final PDF...")
            output_bio = io.BytesIO()
            new_doc.save(output_bio)
            
            final_bytes = output_bio.getvalue()
            print(f"[Fallback] Optimized PDF size: {len(final_bytes)/1024/1024:.2f} MB")
            return final_bytes
            
        except Exception as e:
            print(f"[Fallback] Error optimizing PDF: {e}")
            raise e
        finally:
            # Cleanup temp file
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                    print(f"[Fallback] Cleaned up temp file")
                except:
                    pass
            if 'doc' in locals(): doc.close()
            if 'new_doc' in locals(): new_doc.close()

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


    def analyze_via_rendering(
        self, 
        blob_url: str, 
        page_range: str, 
        dpi: int = 150, 
        max_dimension: int = 3000
    ) -> List[Dict[str, Any]]:
        """
        Robust strategy: Download PDF -> Render specific pages to Images -> Analyze Images.
        Bypasses Azure DI's PDF dimension limits (10,000px) and file size limits by controlling the input strictly.
        """
        import requests
        import fitz
        import io
        import tempfile
        import os
        from PIL import Image

        print(f"[AnalyzeViaRender] Starting robust analysis for {page_range}...")
        
        all_chunks = []
        tmp_path = None
        
        try:
            # 1. Download PDF to Temp File
            with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
                tmp_path = tmp_file.name
                with requests.get(blob_url, stream=True) as r:
                    r.raise_for_status()
                    for chunk in r.iter_content(chunk_size=8192):
                        tmp_file.write(chunk)
            
            # 2. Open PDF
            doc = fitz.open(tmp_path)
            
            # 3. Parse Page Range
            # Simple parser: "1-3" -> [0, 1, 2]
            target_indices = []
            if "-" in str(page_range):
                start, end = map(int, str(page_range).split('-'))
                target_indices = range(start - 1, end)
            elif "," in str(page_range):
                target_indices = [int(p) - 1 for p in str(page_range).split(',')]
            else:
                target_indices = [int(page_range) - 1]
                
            print(f"[AnalyzeViaRender] Rendering {len(target_indices)} pages...")

            # 4. Process Each Page
            for p_idx in target_indices:
                if p_idx < 0 or p_idx >= len(doc): continue
                
                page = doc.load_page(p_idx)
                
                # Check dimensions & Scale
                rect = page.rect
                scale = dpi / 72.0
                if rect.width * scale > max_dimension or rect.height * scale > max_dimension:
                    scale = min(max_dimension / rect.width, max_dimension / rect.height)
                
                mat = fitz.Matrix(scale, scale)
                pix = page.get_pixmap(matrix=mat)
                
                # Convert to JPEG bytes
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                img_bio = io.BytesIO()
                img.save(img_bio, format="JPEG", quality=85)
                img_bytes = img_bio.getvalue()
                
                print(f"[AnalyzeViaRender] Page {p_idx+1} rendered: {pix.width}x{pix.height}, {len(img_bytes)/1024:.1f}KB")
                
                # Analyze this single image bytes
                # We reuse the specific byte analyzer method if available, or call client directly
                poller = self.client.begin_analyze_document(
                    "prebuilt-layout", 
                    body=img_bytes,
                    content_type="application/octet-stream",
                    features=[DocumentAnalysisFeature.BARCODES, DocumentAnalysisFeature.STYLE_FONT]
                )
                result = poller.result()
                
                # Extract content
                # Note: result.pages[0] corresponds to our single image
                if result.pages:
                    chunk = self._extract_page_content(result.pages[0], result)
                    # FIX: Correct the page number to match the original PDF
                    chunk["page_number"] = p_idx + 1
                    all_chunks.append(chunk)

            return all_chunks
            
        except Exception as e:
            print(f"[AnalyzeViaRender] Failed: {e}")
            raise e
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except: pass
            if 'doc' in locals(): doc.close()

# Singleton instance
_doc_intel_service = None

def get_doc_intel_service() -> DocumentIntelligenceService:
    """Get or create singleton Document Intelligence service"""
    global _doc_intel_service
    if _doc_intel_service is None:
        _doc_intel_service = DocumentIntelligenceService()
    return _doc_intel_service
