
from app.services.blob_storage import get_container_client

def reset_manual():
    container = get_container_client()
    filename = "제4권 도면_2018.10.22.pdf"
    
    # 1. Delete Status
    status_blob = f"temp/status/{filename}.status.json"
    try:
        container.get_blob_client(status_blob).delete_blob()
        print(f"Deleted status: {status_blob}")
    except:
        print(f"Status not found: {status_blob}")

    # 2. Delete Empty JSON
    json_blob = f"json/제4권 도면_2018.10.22.json"
    try:
        container.get_blob_client(json_blob).delete_blob()
        print(f"Deleted empty JSON: {json_blob}")
    except:
        print(f"JSON not found: {json_blob}")

if __name__ == "__main__":
    reset_manual()
