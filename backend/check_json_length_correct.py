
from app.services.blob_storage import get_container_client
import json

def check_json_length():
    container = get_container_client()
    blob_name = "관리자/json/제4권 도면_2018.10.22.json"
    print(f"Downloading {blob_name}...")
    try:
        data = container.get_blob_client(blob_name).download_blob().readall().decode('utf-8')
        items = json.loads(data)
        count = len(items)
        print(f"Total items in JSON: {count}")
        if count > 0:
            last_item = items[-1]
            print(f"Last item page_number: {last_item.get('page_number', 'N/A')}")
            
            # Check unique page numbers
            pages = set()
            for item in items:
                pages.add(item.get('page_number'))
            print(f"Unique pages found: {len(pages)}")
            print(f"Max page number: {max(pages) if pages else 0}")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_json_length()
