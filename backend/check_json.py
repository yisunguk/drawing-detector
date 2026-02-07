
from app.services.blob_storage import get_container_client

def check_json_content():
    container = get_container_client()
    blob_name = "json/제4권 도면_2018.10.22.json"
    print(f"Downloading {blob_name}...")
    try:
        content = container.get_blob_client(blob_name).download_blob().readall().decode('utf-8')
        print(f"Content: {content}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_json_content()
