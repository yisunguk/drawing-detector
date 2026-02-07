
from app.services.blob_storage import get_container_client
import json

def check_json_length():
    container = get_container_client()
    blob_name = "json/제4권 도면_2018.10.22.json"
    print(f"Downloading {blob_name}...")
    try:
        data = container.get_blob_client(blob_name).download_blob().readall().decode('utf-8')
        items = json.loads(data)
        count = len(items)
        print(f"Total items in JSON: {count}")
        if count > 0:
            last_item = items[-1]
            print(f"Last item page_number: {last_item.get('page_number', 'N/A')}")
            print(f"First item page_number: {items[0].get('page_number', 'N/A')}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_json_length()
