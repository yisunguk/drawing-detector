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
        
        # Extract tables
        tables_by_page = self._extract_tables(result)
        
        for page in result.pages:
            # Construct layout lines
            lines_data = []
            for line in page.lines:
                # Polygon is a list of Point(x, y). Convert to [x1, y1, x2, y2, ...]
                polygon_coords = []
                for point in line.polygon:
                    polygon_coords.extend([point.x, point.y])
                    
                lines_data.append({
                    "content": line.content,
                    "polygon": polygon_coords
                })

            page_data = {
                "content": self._get_page_content(result.content, page.spans),
                "page_number": page.page_number,
                "tables_count": len([t for t in result.tables if any(r.page_number == page.page_number for c in t.cells for r in c.bounding_regions)]),
                "tables": tables_by_page.get(page.page_number, []),
                "도면명(TITLE)": "",
                "도면번호(DWG. NO.)": "REV.",
                "layout": {
                    "width": page.width,
                    "height": page.height,
                    "unit": page.unit,
                    "lines": lines_data
                }
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
            # Checking all cells to find the page number is safer, but typically a table starts on one page.
            # Azure Tables can span pages, but the bounding_regions will show that.
            # For simplicity, we assign the table to the page of its first cell.
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
                    "kind": cell.kind  # columnHeader, rowHeader, content, etc.
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
