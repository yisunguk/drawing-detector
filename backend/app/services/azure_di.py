import json
from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import HttpResponseError
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

    def analyze_document_from_url(self, document_url: str, pages: str = None) -> list:
        if not self.client:
            raise Exception("Azure Document Intelligence client not initialized")

        try:
            print(f"[AzureDIService] Analyzing URL: {document_url[:60]}... Pages={pages}")
            # Stable SDK v3.3 uses begin_analyze_document_from_url
            poller = self.client.begin_analyze_document_from_url(
                "prebuilt-layout", 
                document_url,
                pages=pages
            )
            result = poller.result()
            
            return self._format_result(result)
            
        except HttpResponseError as e:
            print("[DI] HttpResponseError:", str(e))
            # Diagnostic: Print details to understand InvalidRequest / InvalidContentLength
            try:
                if hasattr(e, 'response'):
                     print("[DI] response headers:", dict(e.response.headers))
                     print("[DI] response status:", e.response.status_code)
                     print("[DI] response text:", e.response.text())
            except Exception as inner_e:
                print(f"[DI] Failed to log response details: {inner_e}")
            
            # Re-raise to let RobustAnalysisManager handle chunk splitting
            raise e

    def analyze_document_from_bytes(self, file_content: bytes) -> list:
        if not self.client:
            raise Exception("Azure Document Intelligence client not initialized")

        # Stable SDK v3.3 uses begin_analyze_document with document=bytes
        poller = self.client.begin_analyze_document("prebuilt-layout", document=file_content)
        result = poller.result()
        
        return self._format_result(result)

    def _format_result(self, result) -> list:
        output = []
        
        # --- Global Metadata Extraction (Heuristic) ---
        global_title = ""
        global_drawing_no = ""
        
        # New SDK: result.key_value_pairs is list of DocumentKeyValuePair
        # kvp.key -> DocumentKeyValueElement
        # kvp.key.content -> str
        if result.key_value_pairs:
            for kvp in result.key_value_pairs:
                if kvp.key and kvp.value:
                    key_text = kvp.key.content.lower()
                    value_text = kvp.value.content if kvp.value else ""
                    
                    if "title" in key_text or "도면명" in key_text:
                        global_title = value_text
                    if "dwg" in key_text or "drawing no" in key_text or "도면번호" in key_text:
                        global_drawing_no = value_text

        # Extract tables
        tables_by_page = self._extract_tables(result)
        
        # Start Page Processing
        # result.pages -> list of DocumentPage
        if result.pages:
            for page in result.pages:
                page_num = page.page_number
                
                # Layout Lines
                lines_data = []
                if page.lines:
                    for line in page.lines:
                        # line.polygon -> list of float [x1, y1, x2, y2...] usually
                        # In new SDK, polygon is usually a flattened list of floats.
                        # Check typings: List[float]
                        
                        lines_data.append({
                            "content": line.content,
                            "polygon": line.polygon
                        })
                
                # Page Tables
                page_tables = tables_by_page.get(page_num, [])
                
                # Metadata Fallback
                page_title = global_title
                page_drawing_no = global_drawing_no
                
                if not page_title or not page_drawing_no:
                    # Search tables
                    for table in page_tables:
                        cells = table.get("cells", [])
                        for i, cell in enumerate(cells):
                            content = cell.get("content", "").lower()
                            if i + 1 < len(cells):
                                next_cell_content = cells[i+1].get("content", "")
                                if not page_title and ("title" in content or "도면명" in content):
                                    page_title = next_cell_content
                                if not page_drawing_no and ("dwg" in content or "drawing no" in content or "도면번호" in content):
                                    page_drawing_no = next_cell_content

                page_data = {
                    "content": self._get_page_content(result.content, page.spans),
                    "page_number": page_num,
                    "tables_count": len(page_tables),
                    "도면명(TITLE)": page_title,
                    "도면번호(DWG. NO.)": page_drawing_no or "REV.",
                    "layout": {
                        "width": page.width,
                        "height": page.height,
                        "unit": str(page.unit) if page.unit else "pixel",
                        "lines": lines_data,
                        "words": [] 
                    },
                    "tables": page_tables
                }
                output.append(page_data)
            
        return output

    def _extract_tables(self, result) -> dict:
        tables_by_page = {}
        
        if not result.tables:
            return tables_by_page

        for table in result.tables:
            if not table.cells:
                continue
                
            # Identify page number from first cell
            first_cell = table.cells[0]
            if not first_cell.bounding_regions:
                continue
                
            page_num = first_cell.bounding_regions[0].page_number
            
            cells_data = []
            for cell in table.cells:
                # new SDK: cell.kind -> str ("content", "rowHeader"...) usually str already? 
                # Check typings. DocumentTableCellKind is Enum? 
                # Safer to cast str() just in case.
                
                cells_data.append({
                    "content": cell.content,
                    "row_index": cell.row_index,
                    "column_index": cell.column_index,
                    "kind": str(cell.kind) if cell.kind else "content"
                })
            
            table_data = {
                "row_count": table.row_count,
                "column_count": table.column_count,
                "cells": cells_data
            }
            
            if page_num not in tables_by_page:
                tables_by_page[page_num] = []
            tables_by_page[page_num].append(table_data)
            
        return tables_by_page

    def _get_page_content(self, full_content, spans):
        if not spans:
            return ""
        page_text = ""
        for span in spans:
            # New SDK: span.offset, span.length
            page_text += full_content[span.offset : span.offset + span.length]
        return page_text

azure_di_service = AzureDIService()
