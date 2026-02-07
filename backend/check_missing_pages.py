
from app.services.blob_storage import get_container_client
import json

def check_missing_pages():
    container = get_container_client()
    blob_name = "관리자/json/제4권 도면_2018.10.22.json"
    print(f"Downloading {blob_name}...")
    try:
        data = container.get_blob_client(blob_name).download_blob().readall().decode('utf-8')
        items = json.loads(data)
        
        pages = set()
        for item in items:
            pages.add(int(item.get('page_number')))
            
        print(f"Total Unique Pages: {len(pages)}")
        print(f"Min Page: {min(pages)}")
        print(f"Max Page: {max(pages)}")
        
        missing = []
        for i in range(1, 543):
            if i not in pages:
                missing.append(i)
                
        if missing:
            print(f"Missing {len(missing)} pages.")
            # Print ranges
            ranges = []
            if not missing: return
            
            start = missing[0]
            prev = missing[0]
            
            for p in missing[1:]:
                if p != prev + 1:
                    ranges.append(f"{start}-{prev}")
                    start = p
                prev = p
            ranges.append(f"{start}-{prev}")
            
            print(f"Missing Ranges: {', '.join(ranges)}")
        else:
            print("No missing pages!")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_missing_pages()
