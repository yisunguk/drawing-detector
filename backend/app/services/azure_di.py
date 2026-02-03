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

    def analyze_document_from_url(self, document_url: str, pages: str = None) -> dict:
        if not self.client:
            raise Exception("Azure Document Intelligence client not initialized")

        # Pass pages parameter if provided (e.g., "1-30")
        poller = self.client.begin_analyze_document_from_url(
            "prebuilt-layout", 
            document_url,
            pages=pages
        )
        result = poller.result()
        
        return self._format_result(result)

    def analyze_document_from_bytes(self, file_content: bytes) -> dict:
        if not self.client:
            raise Exception("Azure Document Intelligence client not initialized")

        # Use begin_analyze_document for bytes
        poller = self.client.begin_analyze_document("prebuilt-layout", document=file_content)
        result = poller.result()
        
        return self._format_result(result)

    def _format_result(self, result) -> list:
        output = []
        
        # --- Global Metadata Extraction (Heuristic) ---
        global_title = ""
        global_drawing_no = ""
        
        # Attempt to find Title/DrawingNo in global Key-Value pairs
        if hasattr(result, 'key_value_pairs') and result.key_value_pairs:
            for kvp in result.key_value_pairs:
                if kvp.key and kvp.value:
                    key_text = kvp.key.content.lower()
                    value_text = kvp.value.content
                    
                    if "title" in key_text or "도면명" in key_text:
                        global_title = value_text
                    if "dwg" in key_text or "drawing no" in key_text or "도면번호" in key_text:
                        global_drawing_no = value_text

        # Extract tables
        tables_by_page = self._extract_tables(result)
        
        for page in result.pages:
            page_num = page.page_number
            
            # Construct layout lines
            lines_data = []
            if hasattr(page, 'lines'):
                for line in page.lines:
                    # Polygon is a list of Point(x, y). Convert to [x1, y1, x2, y2, ...]
                    polygon_coords = []
                    if hasattr(line, 'polygon'):
                        for point in line.polygon:
                            polygon_coords.extend([point.x, point.y])
                        
                    lines_data.append({
                        "content": line.content,
                        "polygon": polygon_coords
                    })
            
            # Get Page Tables
            page_tables = tables_by_page.get(page_num, [])
            
            # Metadata Fallback from Tables
            page_title = global_title
            page_drawing_no = global_drawing_no
            
            # If global metadata wasn't found, check table cells (common in Title Blocks)
            if not page_title or not page_drawing_no:
                for table in page_tables:
                    cells = table.get("cells", [])
                    # We need to iterate cells. The structure in _extract_tables returns a list of dicts.
                    for i, cell in enumerate(cells):
                        content = cell.get("content", "").lower()
                        # Simple lookahead for value (assumes value is in next cell)
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
                "도면번호(DWG. NO.)": page_drawing_no or "REV.", # Default if still empty
                "layout": {
                    "width": page.width,
                    "height": page.height,
                    "unit": str(page.unit) if page.unit else "pixel", # Fix Enum serialization
                    "lines": lines_data,
                    "words": [] 
                },
                "tables": page_tables
            }
            output.append(page_data)
            
        return output

    def _extract_tables(self, result) -> dict:
        """
        Extracts tables and groups them by page number.
        Returns a dict: { page_number: [table_data, ...] }
        """
        tables_by_page = {}
        
        if not hasattr(result, 'tables') or not result.tables:
            return tables_by_page

        for table in result.tables:
            if not table.cells:
                continue
                
            # Identify page number from the first cell
            first_cell = table.cells[0]
            if not first_cell.bounding_regions:
                continue
                
            page_num = first_cell.bounding_regions[0].page_number
            
            # Prepare grid structure
            cells_data = []
            for cell in table.cells:
                cells_data.append({
                    "content": cell.content,
                    "row_index": cell.row_index,
                    "column_index": cell.column_index,
                    "kind": str(cell.kind) if cell.kind else "content" # Fix Enum serialization
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
        page_text = ""
        for span in spans:
            page_text += full_content[span.offset : span.offset + span.length]
        return page_text

azure_di_service = AzureDIService()
