import pdfplumber

class PDFExtractor:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.pdf = None

    def extract_text_with_coordinates(self):
        self.pdf = pdfplumber.open(self.file_path)
        blocks = []
        for page in self.pdf.pages:
            text = page.extract_text()
            if text:
                blocks.append({"text": text, "page": page.page_number})
        return blocks
    
    def close(self):
        if self.pdf:
            self.pdf.close()
